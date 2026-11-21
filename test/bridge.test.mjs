import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHandler, buildPrompt, cleanAnswer, claudeArgs, READ_TOOLS, BLOCKED_TOOLS } from '../bridge/claude-bridge.mjs';

test('bridge: folders are added read-only, never with a blanket Read rule, and secrets are blocked', () => {
  const args = claudeArgs({ model: 'sonnet', promptFile: 'p.txt', folders: ['C:/Users/me/Desktop', 'C:/Users/me/Documents'] });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(val('--tools'), 'WebSearch,Read,Glob,Grep'); // no Write, Edit or Bash
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--add-dir'), ['C:/Users/me/Desktop', 'C:/Users/me/Documents']);
  const allowed = val('--allowedTools').split(',');
  assert.ok(!allowed.some((t) => /^(Read|Glob|Grep)/.test(t)), 'a blanket Read rule would open every path');
  const blocked = val('--disallowedTools').split(',');
  assert.ok(blocked.includes('Read(**/.env)') && blocked.includes('Grep(**/*.pem)') && blocked.includes('Read(**/.ssh/**)'));
  // no folders: no file tools at all
  assert.equal(claudeArgs({ model: 'sonnet', promptFile: 'p.txt' })[claudeArgs({ model: 'sonnet', promptFile: 'p.txt' }).indexOf('--tools') + 1], 'WebSearch');
});

test('bridge: read access allows only read tools, refuses the rest, and blocks every write tool', () => {
  const args = claudeArgs({ model: 'sonnet', promptFile: 'p.txt' });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(val('--permission-mode'), 'dontAsk');
  assert.equal(val('--tools'), 'WebSearch'); // no shell, no file tools
  const allowed = val('--allowedTools').split(',');
  const blocked = val('--disallowedTools').split(',');
  assert.ok(allowed.includes('mcp__claude_ai_Gmail__search_threads'));
  assert.ok(blocked.includes('mcp__claude_ai_Gmail__send_message'));
  assert.ok(blocked.includes('mcp__chrome-devtools'));
  for (const t of allowed) assert.ok(!blocked.includes(t), t);
  for (const t of READ_TOOLS) assert.doesNotMatch(t, /__(send|reply|forward|create|update|delete|trash|share|label|append|copy|batch|export|download)/, t);
  assert.ok(BLOCKED_TOOLS.length > 40);
  const web = claudeArgs({ model: 'sonnet', promptFile: 'p.txt', access: 'web' });
  assert.ok(web.includes('--strict-mcp-config'));
  assert.ok(!web.join(' ').includes('mcp__claude_ai_Gmail__search_threads'));
});

test('bridge: answers are tidied into plain text for the card', () => {
  const raw = 'Today is **Saturday**.\n\nSee [the report](https://example.com/x) for more.\n\nSources:\n- [Example](https://example.com/x)\n- [Other](https://other.example)';
  assert.equal(cleanAnswer(raw), 'Today is Saturday.\n\nSee the report for more.');
  assert.equal(cleanAnswer('## Steps\n- one\n- two'), 'Steps\n- one\n- two');
});

async function withServer(opts, fn) {
  const server = http.createServer(createHandler({ token: 'secret-token', model: 'sonnet', ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const post = (base, body, headers = {}) => fetch(`${base}/ask`, { method: 'POST', body: JSON.stringify(body), headers });

test('bridge: needs the token; ping works; CORS only for the dashboard', async () => {
  await withServer({ runClaude: async () => 'unused' }, async (base) => {
    assert.equal((await post(base, { token: 'wrong', op: 'ping' })).status, 401);
    assert.equal((await post(base, { op: 'ping' })).status, 401);
    const ok = await post(base, { token: 'secret-token', op: 'ping' }, { origin: 'https://lucasp91.github.io' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, model: 'sonnet' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://lucasp91.github.io');
    const evil = await post(base, { token: 'secret-token', op: 'ping' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${base}/ask`, { method: 'OPTIONS', headers: { origin: 'https://lucasp91.github.io' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    assert.equal((await post(base, 'not json')).status, 401);
  });
});

test('bridge: asks Claude with the question and recent history, one at a time', async () => {
  const prompts = [];
  let running = 0;
  let maxRunning = 0;
  const runClaude = async (p) => {
    prompts.push(p);
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
    return 'Answer ' + prompts.length;
  };
  await withServer({ runClaude }, async (base) => {
    const ask = (text, history) => post(base, { token: 'secret-token', op: 'ask', text, history }).then((r) => r.json());
    const [a, b] = await Promise.all([ask('First?', [{ text: 'Earlier?', answer: 'Yes.' }]), ask('Second?')]);
    assert.equal(a.answer, 'Answer 1');
    assert.equal(b.answer, 'Answer 2');
    assert.equal(maxRunning, 1);
    assert.match(prompts[0], /Earlier in this conversation:\nQ: Earlier\?\nA: Yes\.\n\nQuestion: First\?$/);
    assert.match(prompts[0], /^Now: /);
    assert.equal((await post(base, { token: 'secret-token', op: 'ask', text: '  ' })).status, 400);
  });
});

test('bridge: reports Claude Code failures and limits the queue', async () => {
  await withServer({ runClaude: async () => { throw new Error('Claude Code isn’t signed in on the computer.'); } }, async (base) => {
    const r = await post(base, { token: 'secret-token', op: 'ask', text: 'Hi?' });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /signed in/);
  });
  let release;
  const gate = new Promise((r) => { release = r; });
  await withServer({ runClaude: async () => { await gate; return 'ok'; } }, async (base) => {
    const asks = [1, 2, 3].map(() => post(base, { token: 'secret-token', op: 'ask', text: 'Q?' }));
    await new Promise((r) => setTimeout(r, 50));
    const fourth = await post(base, { token: 'secret-token', op: 'ask', text: 'Q?' });
    assert.equal(fourth.status, 429);
    release();
    for (const r of await Promise.all(asks)) assert.equal(r.status, 200);
  });
});

test('bridge: prompt without history is just the time and the question', () => {
  assert.match(buildPrompt('Hi?'), /^Now: .+\n\nQuestion: Hi\?$/);
});
