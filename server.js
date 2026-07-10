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

const DIR = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'plugin.json'), 'utf8'));
const PORT = Number(process.env.PORT || (manifest.server && manifest.server.port) || 9200);

// The hub injects the bus URL + this plugin's scoped token. Accept the common
// conventions so the scaffold runs however your hub wires it.
const BUS_URL = process.env.WKS_BUS_URL || 'ws://127.0.0.1:7895/bus';
function readToken() {
  if (process.env.WKS_BUS_TOKEN) return process.env.WKS_BUS_TOKEN;
  try { return fs.readFileSync(path.join(DIR, '.bus-token'), 'utf8').trim(); } catch { return ''; }
}
// Host-injected settings (from manifest `settings`), passed as JSON in env.
let settings = {};
try { settings = JSON.parse(process.env.WKS_SETTINGS || '{}'); } catch {}

const TOPICS = manifest.consumes || [];
const recent = [];
let ws = null, connected = false, callSeq = 0;
const pending = new Map();

function log(msg) {
  console.log('[' + manifest.id + '] ' + msg);
  recent.unshift(new Date().toISOString() + '  ' + msg);
  if (recent.length > 100) recent.pop();
}

// Call a hub capability (must be declared in plugin.json `capabilities`).
function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!connected) return reject(new Error('not connected'));
    const id = 'c' + (++callSeq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 'call', id, method, params: params || {} }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 8000);
  });
}
// Publish an event/command (must be declared in `emits`).
function publish(type, data) {
  if (connected) ws.send(JSON.stringify({ op: 'publish', event: { type, source: manifest.id, data: data || {} } }));
}

function connect() {
  const tok = readToken();
  ws = new WebSocket(BUS_URL + (tok ? '?token=' + encodeURIComponent(tok) : ''));
  ws.addEventListener('open', () => {
    connected = true;
    if (TOPICS.length) ws.send(JSON.stringify({ op: 'subscribe', topics: TOPICS }));
    log('connected; subscribed to ' + (TOPICS.join(', ') || '(nothing)'));
  });
  ws.addEventListener('message', (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.op === 'event' && f.event) onEvent(f.event).catch((e) => log('onEvent error: ' + e.message));
    else if (f.op === 'result' && pending.has(f.id)) { pending.get(f.id).resolve(f.result); pending.delete(f.id); }
    else if (f.op === 'error' && pending.has(f.id)) { pending.get(f.id).reject(new Error(f.error)); pending.delete(f.id); }
  });
  ws.addEventListener('close', () => { connected = false; setTimeout(connect, 1500); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
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
    const roster = await call('agents.list', {});
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
        try { await call('claude.gate', { sessionId, on: false }); } catch (e) { log('ungate failed: ' + e.message); }
        gatedSessions.delete(sessionId);
      }
      return;
    }

    const reason = res.killed
      ? 'timed out after ' + Math.round(CHECK_TIMEOUT_MS / 1000) + 's'
      : 'exited ' + res.code;
    log('check FAILED (' + reason + ') for ' + sessionId + ' — gating');

    // 1) Hold the turn open so the agent can't "finish" red.
    try { await call('claude.gate', { sessionId, on: true }); gatedSessions.add(sessionId); }
    catch (e) { log('claude.gate failed: ' + e.message); }

    // 2) Feed the error output back to the agent so it can fix it. (claude.gate
    //    is a boolean hold and can't carry a message, so we deliver the details
    //    via agents.sendMessage.)
    const feedback =
      'Typecheck gate: `' + CHECK_COMMAND + '` ' + reason + ' in ' + cwd + '.\n' +
      "Do not finish yet — fix these errors, then re-run the check:\n\n" +
      (tail(res.output, MAX_FEEDBACK_CHARS) || '(no output captured)');
    try { await call('agents.sendMessage', { sessionId, text: feedback }); }
    catch (e) { log('agents.sendMessage failed: ' + e.message); }

    // 3) Let the human know.
    try {
      await call('notifications.post', {
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
    + (connected ? '\u{1F7E2} connected to hub' : '\u{1F534} disconnected')
    + ' · subscribed to ' + (TOPICS.join(', ') || '(nothing)') + '</p>'
    + '<pre style="font-size:.7rem;color:var(--wks-text-faint,#777);white-space:pre-wrap">'
    + (recent.map(escapeHtml).join('\n') || 'waiting for events…') + '</pre>'
);
});
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
server.listen(PORT, '127.0.0.1', () => log('pane on http://127.0.0.1:' + PORT));
connect();
