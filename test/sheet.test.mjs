import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBridge } from './apps-script-harness.mjs';
import { sheetClient } from '../logic.js';

const rows = [['Task', 'Done'], ['Buy milk', false], ['Call the dentist', true], ['Oat milk', 'x'], ['', ''], ['Paint the shed', false]];
const texts = (r) => r.items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`);

test('Apps Script: rejects a missing or wrong secret, and bad JSON', () => {
  const b = loadBridge({ rows });
  assert.deepEqual(b.post({ actions: [] }), { error: 'Unauthorized' });
  assert.deepEqual(b.post({ secret: 'nope' }), { error: 'Unauthorized' });
  assert.deepEqual(b.post('{not json'), { error: 'Bad request' });
  assert.deepEqual(loadBridge({ rows, secret: null }).post({ secret: '' }), { error: 'Unauthorized' });
});

test('Apps Script: reads rows Duet wrote, skipping blanks; "x" counts as done', () => {
  assert.deepEqual(texts(loadBridge({ rows }).post({ secret: 'test-secret' })), ['[ ] Buy milk', '[x] Call the dentist', '[x] Oat milk', '[ ] Paint the shed']);
});

test('Apps Script: add, tick (exact match wins), untick, remove, clear done', () => {
  const b = loadBridge({ rows });
  const s = 'test-secret';
  b.post({ secret: s, actions: [{ op: 'todo_add', items: ['Pay rent', '  water\n plants '] }] });
  assert.deepEqual(b.data.slice(-2), [['Pay rent', false], ['water plants', false]]);
  let r = b.post({ secret: s, actions: [{ op: 'todo_done', match: 'buy milk' }, { op: 'todo_done', match: 'oat milk', done: false }] });
  assert.deepEqual(texts(r).slice(0, 3), ['[x] Buy milk', '[x] Call the dentist', '[ ] Oat milk']);
  r = b.post({ secret: s, actions: [{ op: 'todo_remove', match: 'paint the shed' }, { op: 'todo_clear_done' }] });
  assert.deepEqual(texts(r), ['[ ] Oat milk', '[ ] Pay rent', '[ ] water plants']);
});

test('Apps Script: setup writes the header to an empty sheet and keeps an existing secret', () => {
  const b = loadBridge({ rows: [], secret: null });
  assert.equal(b.ctx.setup(), 'uuid-1234');
  assert.deepEqual(b.data[0], ['Task', 'Done']);
  b.props.set('SECRET', 'mine');
  assert.equal(b.ctx.setup(), 'mine');
});

test('client: posts a simple text body with only to-do actions, and maps errors', async () => {
  const b = loadBridge({ rows });
  let sent;
  const fake = async (url, opts) => { sent = opts; return { ok: true, json: async () => b.post(opts.body) }; };
  const client = sheetClient({ url: 'https://script.google.com/macros/s/AKfy-abc_123/exec', secret: 'test-secret', fetchImpl: fake });
  const items = await client.sync([{ op: 'add', widget: { type: 'clock' } }, { op: 'todo_add', items: ['Milk'] }]);
  assert.equal(sent.headers, undefined); // no preflight
  assert.deepEqual(JSON.parse(sent.body).actions, [{ op: 'todo_add', items: ['Milk'] }]);
  assert.equal(items.at(-1).text, 'Milk');
  assert.ok(items.every((i) => i.id));

  const bad = sheetClient({ url: 'https://script.google.com/macros/s/x/exec', secret: 'wrong', fetchImpl: fake });
  await assert.rejects(bad.sync(), /rejected the secret/);
  const offline = sheetClient({ url: 'https://script.google.com/macros/s/x/exec', secret: 's', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.sync(), /Can’t reach/);
  const html = sheetClient({ url: 'https://script.google.com/macros/s/x/exec', secret: 's', fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError(); } }) });
  await assert.rejects(html.sync(), /Anyone/);
  assert.throws(() => sheetClient({ url: 'https://evil.example/exec', secret: 's' }), /ends in \/exec/);
});
