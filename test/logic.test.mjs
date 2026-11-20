import test from 'node:test';
import assert from 'node:assert/strict';
import { applyActions, localParse, normalizeAll, parseClaudeReply, askClaude } from '../logic.js';

const run = (widgets, text) => { const r = localParse(text, widgets); return { ...r, widgets: applyActions(widgets, r.actions) }; };
const todoOf = (w) => w.find((x) => x.type === 'todo');

test('adds a task and creates the to-do list on demand', () => {
  const r = run([], 'add buy milk to my to-do list');
  assert.equal(todoOf(r.widgets).items[0].text, 'Buy milk');
  assert.match(r.reply, /Buy milk/);
});

test('spoken "to do" and "remind me to" forms work', () => {
  assert.equal(todoOf(run([], 'Add call mom to my to do list').widgets).items[0].text, 'Call mom');
  assert.equal(todoOf(run([], 'remind me to water the plants').widgets).items[0].text, 'Water the plants');
});

test('commas split tasks, "and" does not', () => {
  const items = todoOf(run([], 'add milk, eggs, call mom and dad to the todo list').widgets).items.map((i) => i.text);
  assert.deepEqual(items, ['Milk', 'Eggs', 'Call mom and dad']);
});

test('ticks off, removes and clears done tasks', () => {
  let w = run([], 'add milk, eggs, bread to my to-do list').widgets;
  w = run(w, 'tick off eggs').widgets;
  assert.deepEqual(todoOf(w).items.map((i) => i.done), [false, true, false]);
  w = run(w, 'remove milk from my to-do list').widgets;
  assert.deepEqual(todoOf(w).items.map((i) => i.text), ['Eggs', 'Bread']);
  w = run(w, 'clear the completed tasks').widgets;
  assert.deepEqual(todoOf(w).items.map((i) => i.text), ['Bread']);
});

test('reports a missing task instead of guessing', () => {
  const w = run([], 'add milk to my to-do list').widgets;
  assert.deepEqual(localParse('remove cheese from my to-do list', w).actions, []);
});

test('timers, weather, notes and clear still parse', () => {
  assert.equal(run([], 'set a timer for 5 minutes').widgets[0].seconds, 300);
  assert.equal(run([], 'weather in new york').widgets[0].city, 'New York');
  assert.equal(run([], 'note: call the dentist').widgets[0].text, 'call the dentist');
  assert.equal(run(run([], 'add a clock').widgets, 'clear the dashboard').widgets.length, 0);
});

test('only one to-do list, and bad input is dropped', () => {
  const out = normalizeAll([{ type: 'todo' }, { type: 'todo' }, { type: 'nope' }, null, { type: 'note', text: 'x'.repeat(5000) }]);
  assert.equal(out.length, 2);
  assert.equal(out[1].text.length, 2000);
});

test('parses a Claude reply wrapped in prose', () => {
  const r = parseClaudeReply('Sure!\n{"reply":"Done","actions":[{"op":"todo_add","items":["a"]}]}');
  assert.equal(r.actions[0].op, 'todo_add');
  assert.throws(() => parseClaudeReply('no json here'));
});

test('askClaude sends the browser-access header and maps errors', async () => {
  let seen;
  const ok = async (url, opts) => { seen = opts; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"reply":"ok","actions":[]}' }] }) }; };
  await askClaude({ apiKey: 'k', model: 'm', text: 'hi', widgets: [], fetchImpl: ok });
  assert.equal(seen.headers['anthropic-dangerous-direct-browser-access'], 'true');
  await assert.rejects(askClaude({ apiKey: 'k', model: 'm', text: 'hi', widgets: [], fetchImpl: async () => ({ ok: false, status: 401 }) }), /rejected the API key/);
});
