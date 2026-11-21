import test from 'node:test';
import assert from 'node:assert/strict';
import { applyActions, localParse, normalizeAll, bridgeClient } from '../logic.js';

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

test('move: actions reorder and clamp, unknown ids are ignored', () => {
  const w = ['a', 'b', 'c'].map((id) => ({ id, type: 'note', title: id, text: id }));
  const order = (list) => list.map((x) => x.id).join('');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'c', to: 'first' }])), 'cab');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'a', to: 'last' }])), 'bca');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'b', to: 'earlier' }])), 'bac');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'a', to: 'earlier' }])), 'abc'); // already first
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'a', to: 1 }])), 'bac');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'a', to: 99 }])), 'bca');
  assert.equal(order(applyActions(w, [{ op: 'move', id: 'zz', to: 'first' }, { op: 'move', id: 'b', to: 'nonsense' }])), 'abc');
});

test('move: voice phrases', () => {
  let w = run([], 'add a clock').widgets;
  w = run(w, 'weather in london').widgets;
  w = run(w, 'add milk to my to-do list').widgets;
  const types = (list) => list.map((x) => x.type).join(',');
  assert.equal(types(w), 'clock,weather,todo');
  assert.equal(types(run(w, 'move the to-do list to the top').widgets), 'todo,clock,weather');
  assert.equal(types(run(w, 'put the clock at the end').widgets), 'weather,todo,clock');
  assert.equal(types(run(w, 'move london left').widgets), 'weather,clock,todo');
  assert.equal(types(run(w, 'move the weather card down').widgets), 'clock,todo,weather');
  assert.match(localParse('move the timer to the top', w).reply, /couldn't find/);
});

test('"Duet, …" is sent to Duet, like a wake word', () => {
  for (const said of ['Duet, what should I cook tonight?', 'duet what should I cook tonight', 'Hey Duet, what should I cook tonight?', 'Ask Duet what should I cook tonight', 'Duette, what should I cook tonight', 'due it what should I cook tonight']) {
    const r = localParse(said, []);
    assert.deepEqual(r.actions, [{ op: 'duet_ask', text: 'What should I cook tonight' + (said.endsWith('?') ? '?' : '') }], said);
  }
  assert.deepEqual(localParse('Duet', []).actions, []);
  assert.match(localParse('Duet,', []).reply, /What should I ask Duet/);
  // a to-do phrased to Duet still goes to Duet (it can edit the sheet itself)
  assert.equal(localParse('Duet, add milk to my to-do list', []).actions[0].op, 'duet_ask');
  // words merely containing "duet" don't trigger it
  assert.notEqual(localParse('add duet practice to my to-do list', []).actions[0]?.op, 'duet_ask');
  assert.match(localParse('what is the capital of peru', []).reply, /“Claude,” for a quick answer, “Duet,”/);
});

test('duet actions keep one Duet card with the newest 20 questions', () => {
  let w = applyActions([], [{ op: 'duet_ask', text: 'First?' }]);
  assert.deepEqual(w.map((x) => x.type), ['duet']);
  for (let i = 0; i < 25; i++) w = applyActions(w, [{ op: 'duet_ask', text: `Q${i}` }]);
  const items = w.find((x) => x.type === 'duet').items;
  assert.equal(items.length, 20);
  assert.equal(items.at(-1).text, 'Q24');
  w = applyActions(w, [{ op: 'duet_remove', match: 'q24' }, { op: 'add', widget: { type: 'duet' } }]);
  assert.equal(w.filter((x) => x.type === 'duet').length, 1);
  assert.equal(w.find((x) => x.type === 'duet').items.at(-1).text, 'Q23');
});

test('"Claude, …" asks Claude on the computer, like a wake word', () => {
  for (const said of ['Claude, how long do I boil an egg?', 'claude how long do I boil an egg?', 'Hey Claude, how long do I boil an egg?', 'Cloud, how long do I boil an egg?', 'Clawed how long do I boil an egg?']) {
    const r = localParse(said, []);
    assert.equal(r.actions.length, 1, said);
    assert.equal(r.actions[0].op, 'claude_ask');
    assert.equal(r.actions[0].text, 'How long do I boil an egg?');
    assert.ok(!Number.isNaN(Date.parse(r.actions[0].asked)));
  }
  assert.deepEqual(localParse('Claude', []).actions, []);
  assert.notEqual(localParse('add cloudberries to my to-do list', []).actions[0]?.op, 'claude_ask');
  assert.equal(localParse('Duet, ask Claude something', []).actions[0].op, 'duet_ask');
});

test('claude actions: ask, answer, fail, retry, remove (matched by asked time)', () => {
  let w = applyActions([], [{ op: 'claude_ask', text: 'One?', asked: 't1' }, { op: 'claude_ask', text: 'Two?', asked: 't2' }]);
  assert.deepEqual(w.map((x) => x.type), ['claude']);
  const items = () => w[0].items;
  w = applyActions(w, [{ op: 'claude_answer', asked: 't1', answer: ' Yes. ' }, { op: 'claude_answer', asked: 't2', error: 'Can’t reach your computer.' }]);
  assert.equal(items()[0].answer, 'Yes.');
  assert.ok(items()[0].answered);
  assert.equal(items()[1].error, 'Can’t reach your computer.');
  w = normalizeAll(JSON.parse(JSON.stringify(w))); // survives saving
  assert.equal(items()[1].error, 'Can’t reach your computer.');
  w = applyActions(w, [{ op: 'claude_retry', asked: 't2' }]);
  assert.equal(items()[1].error, undefined);
  assert.equal(items()[1].answer, '');
  w = applyActions(w, [{ op: 'claude_answer', asked: 'nope', answer: 'x' }, { op: 'claude_remove', asked: 't1' }]);
  assert.deepEqual(items().map((q) => q.text), ['Two?']);
  w = applyActions(w, [{ op: 'add', widget: { type: 'claude' } }]);
  assert.equal(w.length, 1);
});

test('bridge client: checks the address, sends a simple text body, maps errors', async () => {
  assert.throws(() => bridgeClient({ url: 'http://192.168.1.5:5190', token: 't' }), /https/);
  assert.throws(() => bridgeClient({ url: 'https://pc.tail1.ts.net', token: '' }), /token/);
  let seen;
  const ok = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => ({ answer: ' Ten minutes. ' }) }; };
  const c = bridgeClient({ url: 'https://pc.tail1.ts.net/', token: 'tok', fetchImpl: ok });
  const history = [1, 2, 3, 4].map((n) => ({ text: `q${n}`, answer: `a${n}`, extra: 'dropped' }));
  assert.equal(await c.ask('How long?', history), 'Ten minutes.');
  assert.equal(seen.url, 'https://pc.tail1.ts.net/ask');
  assert.equal(seen.opts.headers, undefined); // no Content-Type: no CORS preflight
  const sent = JSON.parse(seen.opts.body);
  assert.equal(sent.token, 'tok');
  assert.deepEqual(sent.history, [{ text: 'q2', answer: 'a2' }, { text: 'q3', answer: 'a3' }, { text: 'q4', answer: 'a4' }]);
  const status = (code, body = {}) => bridgeClient({ url: 'http://localhost:5190', token: 't', fetchImpl: async () => ({ ok: code < 300, status: code, json: async () => body }) });
  await assert.rejects(status(401).ping(), /rejected the token/);
  await assert.rejects(status(429, { error: 'Busy now.' }).ask('x'), /Busy now/);
  await assert.rejects(status(502, { error: 'Claude Code isn’t signed in' }).ask('x'), /signed in/);
  await assert.rejects(bridgeClient({ url: 'http://localhost:5190', token: 't', fetchImpl: async () => { throw new TypeError('Load failed'); } }).ping(), /Can’t reach your computer/);
});
