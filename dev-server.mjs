// Local preview only (GitHub Pages serves the real site). localhost counts as a secure context,
// so the microphone works here in a desktop browser too.
//
// It also serves a mock Google Sheet at /mock-sheet that runs the real apps-script/Code.gs against an
// in-memory sheet, so sync can be tested without a Google account:
//   Settings → Web app URL: http://localhost:5180/mock-sheet   Secret: test-secret
//   PUT  /mock-sheet/rows     body: [["Task","Done"],["Buy milk",false]]   (pretend to be Claude Duet editing the sheet)
//   GET  /mock-sheet/rows     current rows (add ?tab=Questions for the Duet questions tab)
//   PUT  /mock-sheet/rows?tab=Questions   body: rows   (pretend to be Duet answering questions)
//   POST /mock-sheet/offline  body: {"on":true}   (simulate the sheet being unreachable)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBridge } from './test/apps-script-harness.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5180;
const FILES = new Set(['index.html', 'app.js', 'logic.js', 'style.css']); // the same files the Pages workflow publishes
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

let bridge = loadBridge({ rows: [['Task', 'Done']] });
let offline = false;

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.slice(1) || 'index.html';
  const tab = url.searchParams.get('tab');

  if (name === 'mock-sheet' && req.method === 'POST') {
    const body = await readBody(req);
    if (offline) return json(res, 503, { error: 'offline' });
    return json(res, 200, bridge.post(body));
  }
  if (name === 'mock-sheet/rows' && req.method === 'GET') return json(res, 200, tab ? bridge.tab(tab) : bridge.data);
  if (name === 'mock-sheet/rows' && req.method === 'PUT') {
    const rows = JSON.parse(await readBody(req));
    if (tab === 'Questions') {
      const current = bridge.tab('Questions');
      if (current) { current.length = 0; current.push(...rows); } else bridge = loadBridge({ rows: bridge.data, questions: rows });
      return json(res, 200, bridge.tab('Questions'));
    }
    bridge = loadBridge({ rows, questions: bridge.tab('Questions') });
    return json(res, 200, bridge.data);
  }
  if (name === 'mock-sheet/offline' && req.method === 'POST') {
    offline = !!JSON.parse(await readBody(req)).on;
    return json(res, 200, { offline });
  }

  if (!FILES.has(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(name)], 'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(ROOT, name)));
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}/   Mock sheet: http://localhost:${PORT}/mock-sheet (secret: test-secret)`));
