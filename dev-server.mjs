// Local preview only (GitHub Pages serves the real site). localhost counts as a secure context,
// so the microphone works here in a desktop browser too.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5180;
const FILES = new Set(['index.html', 'app.js', 'logic.js', 'style.css']); // the same files the Pages workflow publishes
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const name = new URL(req.url, 'http://x').pathname.slice(1) || 'index.html';
  if (!FILES.has(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(name)], 'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(ROOT, name)));
}).listen(PORT, '127.0.0.1', () => console.log(`Preview: http://localhost:${PORT}/`));
