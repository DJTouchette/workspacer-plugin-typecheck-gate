#!/usr/bin/env node
// Generic workspacer plugin sidecar scaffold — zero dependencies.
// Node >= 22 (global WebSocket) and >= 18 (global fetch). Reads its own
// plugin.json for the bus topics it subscribes to and the capabilities it may
// call, connects to the hub bus, logs events, and serves a tiny status pane.
// Implement your logic in onEvent(). See README for events + capabilities.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { connect } = require('./wks.js');

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The workspacer plugin SDK (vendored wks.js): connect to the hub bus (scoped
// token, auto-subscribe, reconnect loop) and expose ready/on/call/publish/settings.
const wks = connect({ source: manifest.id });
const settings = wks.settings;

const TOPICS = manifest.consumes || [];
const recent = [];

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// ── Typecheck gate logic ──────────────────────────────────────────────────────
// When an agent ends a turn (hookEvent === 'Stop'), run the configured check
// command in the agent's cwd. If it fails, hold the turn open with claude.gate,
// feed the error output back to the agent (agents.sendMessage) so it can fix it,
// and notify the human. If it passes, do nothing.
const CHECK_COMMAND = (settings.checkCommand && String(settings.checkCommand).trim()) || 'npm run typecheck';
const CHECK_TIMEOUT_MS = 180_000; // don't let a wedged check run forever
const COOLDOWN_MS = 8_000;        // coalesce duplicate Stop events for a session
const MAX_FEEDBACK_CHARS = 4_000; // keep the fed-back error tail bounded

// Per-session bookkeeping so we never gate the same Stop twice and never run
// two checks for one session concurrently.
const lastRunAt = new Map();   // sessionId -> epoch ms of last check start
const inFlight = new Set();    // sessionIds with a check currently running
const gatedSessions = new Set(); // sessionIds we've turned the gate on for

// Resolve the agent's working directory: prefer the event payload, fall back to
// the live roster (agents.list) keyed by sessionId.
async function resolveCwd(sessionId, evCwd) {
  if (evCwd && typeof evCwd === 'string') return evCwd;
  try {
    const roster = await wks.call('agents.list', {});
    if (Array.isArray(roster)) {
      const hit = roster.find((a) => a && a.sessionId === sessionId);
      if (hit && hit.cwd) return hit.cwd;
    }
  } catch (e) {
    log('agents.list fallback failed: ' + e.message);
  }
  return null;
}

// Run the check command async so we never block the bus event loop.
function runCheck(cwd) {
  return new Promise((resolve) => {
    exec(
      CHECK_COMMAND,
      { cwd, timeout: CHECK_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const out = ((stdout || '') + (stderr || '')).trim();
        if (!err) return resolve({ ok: true, output: out });
        // err.code is the exit status; null means killed (e.g. timeout).
        resolve({ ok: false, output: out, code: err.code ?? null, killed: !!err.killed });
      },
    );
  });
}

function tail(s, n) {
  if (!s) return '';
  return s.length > n ? '…\n' + s.slice(-n) : s;
}

async function onEvent(event) {
  const data = event && event.data ? event.data : {};
  // Only care about an agent that just ended a turn.
  if (event.type !== 'agent.state_changed' || data.hookEvent !== 'Stop') return;

  const sessionId = data.sessionId;
  if (!sessionId) return;

  // Dedup: skip if a check is running or one ran very recently for this session.
  if (inFlight.has(sessionId)) return;
  const prev = lastRunAt.get(sessionId);
  if (prev && Date.now() - prev < COOLDOWN_MS) return;

  const cwd = await resolveCwd(sessionId, data.cwd);
  if (!cwd) { log('no cwd for ' + sessionId + '; skipping check'); return; }

  lastRunAt.set(sessionId, Date.now());
  inFlight.add(sessionId);
  log('Stop → running `' + CHECK_COMMAND + '` in ' + cwd + ' (' + sessionId + ')');
  try {
    const res = await runCheck(cwd);
    if (res.ok) {
      log('check passed for ' + sessionId);
      // If we'd previously gated this session, release the hold now that it's green.
      if (gatedSessions.has(sessionId)) {
        try { await wks.call('claude.gate', { sessionId, on: false }); } catch (e) { log('ungate failed: ' + e.message); }
        gatedSessions.delete(sessionId);
      }
      return;
    }

    const reason = res.killed
      ? 'timed out after ' + Math.round(CHECK_TIMEOUT_MS / 1000) + 's'
      : 'exited ' + res.code;
    log('check FAILED (' + reason + ') for ' + sessionId + ' — gating');

    // 1) Hold the turn open so the agent can't "finish" red.
    try { await wks.call('claude.gate', { sessionId, on: true }); gatedSessions.add(sessionId); }
    catch (e) { log('claude.gate failed: ' + e.message); }

    // 2) Feed the error output back to the agent so it can fix it. (claude.gate
    //    is a boolean hold and can't carry a message, so we deliver the details
    //    via agents.sendMessage.)
    const feedback =
      'Typecheck gate: `' + CHECK_COMMAND + '` ' + reason + ' in ' + cwd + '.\n' +
      "Do not finish yet — fix these errors, then re-run the check:\n\n" +
      (tail(res.output, MAX_FEEDBACK_CHARS) || '(no output captured)');
    try { await wks.call('agents.sendMessage', { sessionId, text: feedback }); }
    catch (e) { log('agents.sendMessage failed: ' + e.message); }

    // 3) Let the human know.
    try {
      await wks.call('notifications.post', {
        title: 'Typecheck gate blocked a finish',
        body: '`' + CHECK_COMMAND + '` ' + reason + ' in ' + cwd,
      });
    } catch (e) { log('notifications.post failed: ' + e.message); }
  } finally {
    inFlight.delete(sessionId);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=2>'
    + '<title>' + manifest.name + '</title><body style="font-family:system-ui;'
    + 'background:var(--wks-bg-base,#161616);color:var(--wks-text-primary,#e8e8e8);margin:0;padding:14px">'
    + '<h2 style="font-size:1rem">' + manifest.name + '</h2>'
    + '<p style="color:var(--wks-text-muted,#888);font-size:.8rem">'
    + (wks.connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
);
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));

// Route each consumed bus event to onEvent (the SDK subscribes to '*'; we
// dispatch only the topics this plugin declares in plugin.json `consumes`).
for (const t of TOPICS) wks.on(t, (_data, ev) => { onEvent(ev).catch((e) => log('onEvent error: ' + e.message)); });
wks.ready.then(() => log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)')));
