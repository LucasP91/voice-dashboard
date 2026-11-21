// Pure dashboard logic (no DOM): widget validation, actions, the offline command parser, and the Claude prompt.
// Kept separate from app.js so it can be tested in Node.

export const TYPES = new Set(['clock', 'timer', 'note', 'checklist', 'weather', 'todo', 'duet', 'claude']);
export const MAX_QUESTIONS = 20;
const SINGLE = { todo: 'To-do', claude: 'Claude' }; // widgets there can only be one of
// The Claude card holds both kinds of question: "Claude, …" (items, answered by the computer) and
// "Duet, …" (duet, answered through the sheet). 'duet' is only kept to read dashboards saved before they merged.
export const MAX_WIDGETS = 24;
export const MAX_TODOS = 60;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const str = (v, n = 200) => String(v ?? '').slice(0, n);
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function genId() {
  try { return crypto.randomUUID().slice(0, 8); } catch { return Math.random().toString(36).slice(2, 10); }
}

/** Something Claude wants to do, waiting for Allow / Don't allow: { id, title, fields: [[label, value]] }. */
function normalizeApproval(a) {
  return {
    id: str(a?.id, 40),
    title: str(a?.title, 120) || 'Claude wants to do something',
    fields: (Array.isArray(a?.fields) ? a.fields : []).slice(0, 12).map((f) => [str(f?.[0], 40), str(f?.[1], 2100)]).filter((f) => f[1]),
  };
}

function normalizeQuestions(items) {
  return (Array.isArray(items) ? items : [])
    .map((q) => ({ id: genId(), text: str(q?.text, 500).replace(/\s+/g, ' ').trim(), asked: str(q?.asked, 40), answer: str(q?.answer, 4000).trim(), answered: str(q?.answered, 40), ...(q?.error ? { error: str(q.error, 200) } : {}), ...(q?.approval ? { approval: normalizeApproval(q.approval) } : {}) }))
    .filter((q) => q.text)
    .slice(-MAX_QUESTIONS);
}

function normalizeTodoItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, MAX_TODOS)
    .map((i) => (typeof i === 'string'
      ? { id: genId(), text: str(i, 120), done: false }
      : { id: typeof i?.id === 'string' && /^[\w-]{1,40}$/.test(i.id) ? i.id : genId(), text: str(i?.text, 120), done: !!i?.done }))
    .filter((i) => i.text.trim());
}

export function normalizeWidget(w) {
  if (!w || !TYPES.has(w.type)) return null;
  const out = {
    id: typeof w.id === 'string' && /^[\w-]{1,40}$/.test(w.id) ? w.id : genId(),
    type: w.type,
    title: str(w.title, 60),
  };
  switch (w.type) {
    case 'timer': {
      const seconds = clamp(Math.round(Number(w.seconds) || 0), 1, 86400);
      out.seconds = seconds;
      out.endsAt = Number.isFinite(w.endsAt) ? w.endsAt : null;
      out.remainingMs = Number.isFinite(w.remainingMs) ? clamp(w.remainingMs, 0, seconds * 1000) : seconds * 1000;
      break;
    }
    case 'note':
      out.text = str(w.text, 2000);
      break;
    case 'checklist':
      out.items = (Array.isArray(w.items) ? w.items : [])
        .slice(0, 30)
        .map((i) => (typeof i === 'string' ? { text: str(i, 100), done: false } : { text: str(i?.text, 100), done: !!i?.done }))
        .filter((i) => i.text);
      break;
    case 'weather':
      out.city = str(w.city, 60) || 'London';
      break;
    case 'duet':
      out.items = normalizeQuestions(w.items);
      break;
    case 'claude':
      out.items = normalizeQuestions(w.items);
      out.duet = normalizeQuestions(w.duet);
      break;
    case 'todo':
      out.items = normalizeTodoItems(w.items);
      break;
  }
  return out;
}

export function normalizeAll(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let w = normalizeWidget(raw);
    if (w?.type === 'duet') w = normalizeWidget({ id: w.id, type: 'claude', title: SINGLE.claude, items: [], duet: w.items }); // old Duet card
    if (!w || seen.has(w.id)) continue;
    const claude = w.type === 'claude' && out.find((x) => x.type === 'claude');
    if (claude) { // an old Duet card and a Claude card: one card with both
      claude.items = normalizeQuestions([...claude.items, ...w.items]);
      claude.duet = normalizeQuestions([...claude.duet, ...w.duet]);
      continue;
    }
    if (SINGLE[w.type] && out.some((x) => x.type === w.type)) continue; // one to-do list, one Duet card
    seen.add(w.id);
    out.push(w);
    if (out.length >= MAX_WIDGETS) break;
  }
  return out;
}

/** Finds the task a phrase refers to: an exact (case-insensitive) match wins over a partial one. */
function matchTask(items, match) {
  const m = str(match).toLowerCase().trim();
  if (!m) return null;
  return items.find((i) => i.text.toLowerCase() === m)
    || items.find((i) => { const t = i.text.toLowerCase(); return t.includes(m) || m.includes(t); })
    || null;
}
const findTodoItem = (todo, match) => matchTask(todo.items, match);

/** Applies actions to a copy of the widget list and returns the new list. */
export function applyActions(widgets, actions) {
  const list = JSON.parse(JSON.stringify(widgets));
  const ensureSingle = (type) => {
    let w = list.find((x) => x.type === type);
    if (!w && list.length < MAX_WIDGETS) { w = normalizeWidget({ type, title: SINGLE[type], items: [] }); list.push(w); }
    return w;
  };
  const ensureTodo = () => ensureSingle('todo');
  const ensureDuet = () => ensureSingle('claude');

  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.op === 'add') {
      if (a.widget?.type === 'duet') { ensureDuet(); continue; }
      if (SINGLE[a.widget?.type]) { ensureSingle(a.widget.type); continue; }
      const w = normalizeWidget({ ...a.widget, id: undefined });
      if (w && list.length < MAX_WIDGETS) list.push(w);
    } else if (a.op === 'update') {
      const i = list.findIndex((x) => x.id === a.id);
      if (i < 0) continue;
      const changes = a.changes && typeof a.changes === 'object' ? a.changes : {};
      const merged = { ...list[i], ...changes, id: list[i].id, type: list[i].type };
      if ('seconds' in changes) { merged.endsAt = null; merged.remainingMs = undefined; }
      const w = normalizeWidget(merged);
      if (w) list[i] = w;
    } else if (a.op === 'remove') {
      const i = list.findIndex((x) => x.id === a.id);
      if (i >= 0) list.splice(i, 1);
    } else if (a.op === 'clear') {
      list.length = 0;
    } else if (a.op === 'move') {
      const from = list.findIndex((x) => x.id === a.id);
      if (from < 0) continue;
      const last = list.length - 1;
      const to = { first: 0, last, earlier: from - 1, later: from + 1 }[a.to] ?? Number(a.to);
      if (!Number.isInteger(to)) continue;
      const [w] = list.splice(from, 1);
      list.splice(clamp(to, 0, last), 0, w);
    } else if (a.op === 'duet_ask') {
      const duet = ensureDuet();
      const text = str(a.text, 500).replace(/\s+/g, ' ').trim();
      if (duet && text) duet.duet = normalizeQuestions([...duet.duet, { text, asked: new Date().toISOString() }]);
    } else if (a.op === 'duet_remove') {
      const duet = list.find((w) => w.type === 'claude');
      if (duet) duet.duet = duet.duet.filter((q) => q.text.toLowerCase() !== str(a.match, 500).toLowerCase().trim());
    } else if (a.op === 'claude_ask') {
      const card = ensureSingle('claude');
      const text = str(a.text, 500).replace(/\s+/g, ' ').trim();
      if (card && text) card.items = normalizeQuestions([...card.items, { text, asked: str(a.asked, 40) || new Date().toISOString() }]);
    } else if (a.op === 'claude_approval') {
      const q = list.find((w) => w.type === 'claude')?.items.find((x) => x.asked === a.asked);
      if (!q) continue;
      if (a.approval) q.approval = normalizeApproval(a.approval); else delete q.approval;
    } else if (a.op === 'claude_answer' || a.op === 'claude_retry') {
      const q = list.find((w) => w.type === 'claude')?.items.find((x) => x.asked === a.asked);
      if (!q) continue;
      delete q.error;
      delete q.approval;
      if (a.op === 'claude_retry') { q.answer = ''; continue; }
      if (a.error) q.error = str(a.error, 200);
      else { q.answer = str(a.answer, 4000).trim() || '(No answer.)'; q.answered = new Date().toISOString(); }
    } else if (a.op === 'claude_remove') {
      const card = list.find((w) => w.type === 'claude');
      if (card) card.items = card.items.filter((q) => q.asked !== a.asked);
    } else if (a.op === 'todo_add') {
      const todo = ensureTodo();
      if (!todo) continue;
      const texts = (Array.isArray(a.items) ? a.items : [a.text]).map((t) => str(t, 120).trim()).filter(Boolean);
      todo.items = normalizeTodoItems([...todo.items, ...texts]);
    } else if (a.op === 'todo_done') {
      const todo = list.find((w) => w.type === 'todo');
      const item = todo && findTodoItem(todo, a.match);
      if (item) item.done = a.done !== false;
    } else if (a.op === 'todo_remove') {
      const todo = list.find((w) => w.type === 'todo');
      const item = todo && findTodoItem(todo, a.match);
      if (item) todo.items = todo.items.filter((i) => i !== item);
    } else if (a.op === 'todo_clear_done') {
      const todo = list.find((w) => w.type === 'todo');
      if (todo) todo.items = todo.items.filter((i) => !i.done);
    }
  }
  return list;
}

// ---------- offline command parser ----------
const UNITS = { hour: 3600, hr: 3600, minute: 60, min: 60, second: 1, sec: 1 };
const WORD_NUMS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, forty: 40, sixty: 60 };

function parseDuration(l) {
  const m = l.match(/(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|forty|sixty)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/);
  if (!m) return null;
  const n = /^\d/.test(m[1]) ? Number(m[1]) : WORD_NUMS[m[1]];
  return Math.round(n * UNITS[m[2].replace(/s$/, '')]);
}

const TODO = '(?:to-?\\s?do|todo|task)(?:\\s+list)?';
const RE = {
  todoAdd: new RegExp(`^(?:please\\s+)?(?:add|put)\\s+(.+?)\\s+(?:to|on|onto|in)\\s+(?:my\\s+|the\\s+)?${TODO}$`, 'i'),
  todoRemove: new RegExp(`^(?:please\\s+)?(?:remove|delete|cross off)\\s+(.+?)\\s+from\\s+(?:my\\s+|the\\s+)?${TODO}$`, 'i'),
  todoShow: new RegExp(`^(?:please\\s+)?(?:add|make|create|show|start)\\s+(?:me\\s+)?(?:a\\s+|my\\s+|the\\s+)?${TODO}$`, 'i'),
  todoClearDone: /\b(?:clear|remove|delete)\b.*\b(?:done|completed|finished|ticked)\b/i,
  todoRemind: /^(?:remind me to|i need to|i have to|don'?t forget to)\s+(.+)$/i,
  todoDone: /^(?:please\s+)?(?:mark|tick off|tick|check off|cross off|complete)\s+(.+?)(?:\s+(?:as\s+)?(?:done|complete|completed|finished))?$/i,
  todoDone2: /^(?:i\s+)?(?:finished|completed)\s+(.+)$/i,
};

/** Finds the widget a spoken name refers to: its title, its type ("clock", "timers"), or a weather city. */
function findWidget(widgets, target) {
  const t = target.toLowerCase().replace(/^(?:to-?\s?do|todo)(?:\s+list)?$/, 'todo');
  return widgets.find((w) => (w.title || '').toLowerCase().includes(t) || w.type === t.replace(/s$/, '') || (w.city || '').toLowerCase() === t) || null;
}

const splitTasks = (s) => s.split(/[,;]/).map((t) => cap1(t.trim())).filter(Boolean);

// "Duet, …" goes to Claude Duet through the sheet, like talking to Siri. Speech recognition sometimes
// hears "Duet" as "duette" or "due it", so those count too. "Ask Duet …" and "Hey Duet …" work as well.
const DUET = /^\s*(?:hey\s+|ok(?:ay)?\s+|ask\s+)?(?:duet|duets|duette|due\s?it|do\s?it)\b[\s,.:;!?-]*(.*?)\s*$/i;
export const isDuetCommand = (text) => DUET.test(String(text));

// "Claude, …" asks Claude Code on your computer (your subscription) and the answer comes back in seconds.
// Speech recognition often hears "Claude" as "cloud" or "clawed".
const CLAUDE = /^\s*(?:hey\s+|ok(?:ay)?\s+|ask\s+)?(?:claude|claud|clawed|cloud)\b[\s,.:;!?-]*(.*?)\s*$/i;
export const isClaudeCommand = (text) => CLAUDE.test(String(text));

export function localParse(text, widgets = []) {
  const claude = String(text).match(CLAUDE);
  if (claude) {
    const question = claude[1].trim();
    if (!question) return { reply: 'What should I ask Claude? Say “Claude,” then your question.', actions: [] };
    return { reply: 'Asking Claude…', actions: [{ op: 'claude_ask', text: cap1(question), asked: new Date().toISOString() }] };
  }

  const duet = String(text).match(DUET);
  if (duet) {
    const question = duet[1].trim();
    if (!question) return { reply: 'What should I ask Duet? Say “Duet,” then your question.', actions: [] };
    return { reply: 'Sent to Duet. The answer will show on the Claude card when Duet checks in.', actions: [{ op: 'duet_ask', text: cap1(question) }] };
  }

  const t = text.trim();
  const l = t.toLowerCase().replace(/[.!?]+$/, '');
  const clean = t.replace(/[.!?]+$/, '');
  const todo = widgets.find((w) => w.type === 'todo');

  if (/\b(clear|reset|wipe)\b.*\b(dashboard|everything|all|screen)\b/.test(l)) {
    return { reply: 'Dashboard cleared.', actions: [{ op: 'clear' }] };
  }
  if (RE.todoClearDone.test(l) && /\b(task|tasks|item|items|to-?do)\b/.test(l)) {
    return { reply: 'Cleared the finished tasks.', actions: [{ op: 'todo_clear_done' }] };
  }

  let m = clean.match(RE.todoAdd);
  if (m) { const items = splitTasks(m[1]); return { reply: items.length > 1 ? `Added ${items.length} tasks.` : `Added “${items[0]}”.`, actions: [{ op: 'todo_add', items }] }; }

  m = clean.match(RE.todoRemind);
  if (m) { const items = splitTasks(m[1]); return { reply: `Added “${items[0]}”.`, actions: [{ op: 'todo_add', items }] }; }

  m = clean.match(RE.todoRemove);
  if (m) {
    return todo && findTodoItem(todo, m[1])
      ? { reply: `Removed “${m[1]}”.`, actions: [{ op: 'todo_remove', match: m[1] }] }
      : { reply: `I couldn't find “${m[1]}” on your to-do list.`, actions: [] };
  }

  if (RE.todoShow.test(clean)) return { reply: 'To-do list ready.', actions: [{ op: 'add', widget: { type: 'todo' } }] };

  m = clean.match(RE.todoDone) || clean.match(RE.todoDone2);
  if (m && todo && findTodoItem(todo, m[1])) return { reply: `Ticked off “${m[1]}”.`, actions: [{ op: 'todo_done', match: m[1] }] };

  const mv = l.match(/^(?:move|put)\s+(?:the\s+|my\s+)?(.+?)(?:\s+widget|\s+card)?\s+(?:to\s+|at\s+)?(?:the\s+)?(top|first|start|front|beginning|bottom|last|end|back|up|down|left|right|earlier|later)$/);
  if (mv) {
    const hit = findWidget(widgets, mv[1]);
    if (!hit) return { reply: `I couldn't find “${mv[1]}” on the dashboard.`, actions: [] };
    const to = { top: 'first', first: 'first', start: 'first', front: 'first', beginning: 'first', bottom: 'last', last: 'last', end: 'last', back: 'last', up: 'earlier', left: 'earlier', earlier: 'earlier', down: 'later', right: 'later', later: 'later' }[mv[2]];
    const name = hit.title || hit.type;
    return { reply: { first: `Moved ${name} to the start.`, last: `Moved ${name} to the end.`, earlier: `Moved ${name} earlier.`, later: `Moved ${name} later.` }[to], actions: [{ op: 'move', id: hit.id, to }] };
  }

  const rm = l.match(/^(?:remove|delete|get rid of)\s+(?:the\s+|my\s+)?(.+?)(?:\s+widget)?$/);
  if (rm) {
    const target = rm[1];
    const hit = findWidget(widgets, target);
    return hit
      ? { reply: `Removed ${hit.title || hit.type}.`, actions: [{ op: 'remove', id: hit.id }] }
      : { reply: `I couldn't find “${target}” on the dashboard.`, actions: [] };
  }

  const note = t.match(/^(?:add\s+|make\s+|create\s+)?(?:a\s+)?note\s*(?:that|saying|to self)?\s*[:,-]?\s*(.+)$/i);
  if (note) return { reply: 'Note added.', actions: [{ op: 'add', widget: { type: 'note', title: 'Note', text: note[1] } }] };

  if (/\btimer\b|\bcountdown\b/.test(l)) {
    const seconds = parseDuration(l);
    if (!seconds) return { reply: 'How long should the timer be?', actions: [] };
    return { reply: 'Timer ready. Tap start.', actions: [{ op: 'add', widget: { type: 'timer', title: 'Timer', seconds } }] };
  }

  const wx = l.match(/weather(?:\s+(?:for|in|at))?\s+(.+)$/) || l.match(/(?:in|for)\s+(.+?)\s+weather$/);
  if (wx) return { reply: `Weather for ${cap(wx[1])} added.`, actions: [{ op: 'add', widget: { type: 'weather', city: cap(wx[1]) } }] };
  if (/\bweather\b/.test(l)) return { reply: 'Which city?', actions: [] };

  const list = t.match(/(?:checklist|shopping list|list)\b\s*(?:of|for|with)?\s*[:,-]?\s*(.+)$/i);
  if (list) {
    const items = list[1].split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);
    if (items.length) return { reply: 'Checklist added.', actions: [{ op: 'add', widget: { type: 'checklist', title: 'Checklist', items } }] };
  }

  if (/\bclock\b|\bwhat time\b/.test(l)) return { reply: 'Clock added.', actions: [{ op: 'add', widget: { type: 'clock', title: 'Clock' } }] };

  return { reply: "I didn't catch that. Start with “Claude,” for a quick answer, “Duet,” to send it to Claude Duet, or try “add milk to my to-do list”.", actions: [] };
}

// ---------- Claude on your computer (bridge/claude-bridge.mjs) ----------
// The bridge runs Claude Code, signed in with your Claude subscription, so no API key is involved.
export class BridgeError extends Error {}

// HTTPS (e.g. a Tailscale address), or plain http on this computer for testing.
const BRIDGE_URL = /^(https:\/\/[a-z0-9.-]+(?::\d+)?|http:\/\/(?:localhost|127\.0\.0\.1):\d+)\/?$/i;
export const ASK_TIMEOUT_MS = 200_000;

export function bridgeClient({ url, token, fetchImpl = (...a) => fetch(...a) }) {
  const base = String(url || '').trim().replace(/\/$/, '');
  if (!BRIDGE_URL.test(base)) throw new BridgeError('Paste the bridge address, starting with https:// (for example https://my-pc.tail1234.ts.net).');
  if (!token) throw new BridgeError('Paste the token the bridge printed when it started.');

  async function post(body, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      // text/plain body (no Content-Type header) keeps this a simple request, with no CORS preflight
      res = await fetchImpl(`${base}/ask`, { method: 'POST', body: JSON.stringify({ token, ...body }), signal: ctrl?.signal });
    } catch (err) {
      throw new BridgeError(err?.name === 'AbortError' ? 'Claude took too long to answer.' : 'Can’t reach your computer. Is it on, with the bridge running?');
    } finally {
      clearTimeout(timer);
    }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401) throw new BridgeError('Your computer rejected the token.');
    if (res.status === 429) throw new BridgeError(str(data.error, 200) || 'Your computer is busy. Try again in a moment.');
    if (!res.ok || data.error) throw new BridgeError(str(data.error, 200) || `Bridge error (${res.status}).`);
    return data;
  }

  return {
    /** Checks the bridge is up and the token is right. */
    async ping() { return post({ op: 'ping' }, 10_000); },
    /** Starts answering in the background. id: the question's "asked" time. */
    async start(id, text, history = []) {
      return post({ op: 'start', id, text: str(text, 1000), history: history.slice(-3).map((h) => ({ text: str(h.text, 500), answer: str(h.answer, 2000) })) }, 20_000);
    },
    /** { state: queued|thinking|approval|done|error|unknown, answer, error, approval } */
    async status(id) { return post({ op: 'status', id }, 15_000); },
    /** Answers an approval request (Allow = true). */
    async decide(id, approval, allow) { return post({ op: 'decide', id, approval, allow: !!allow }, 15_000); },
    /** history: earlier [{ text, answer }] pairs, oldest first, so follow-up questions make sense. */
    async ask(text, history = []) {
      const data = await post({ op: 'ask', text: str(text, 1000), history: history.slice(-3).map((h) => ({ text: str(h.text, 500), answer: str(h.answer, 2000) })) }, ASK_TIMEOUT_MS);
      return str(data.answer, 4000).trim();
    },
  };
}

// ---------- to-do list synced with a Google Sheet (via the Apps Script in apps-script/Code.gs) ----------
// Claude Duet edits the sheet's rows; the dashboard sends to-do actions to the script and gets the full list back.

export const isTodoAction = (a) => typeof a?.op === 'string' && a.op.startsWith('todo_');
/** Actions the sheet handles: to-do changes and Duet questions. */
export const isSheetAction = (a) => typeof a?.op === 'string' && (a.op.startsWith('todo_') || a.op.startsWith('duet_'));

export class SheetError extends Error {}

// Real deployments end in /exec on script.google.com; localhost is allowed for the local mock.
const SHEET_URL = /^(https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec|http:\/\/localhost:\d+\/[\w/-]*)$/;

export function sheetClient({ url, secret, fetchImpl = (...a) => fetch(...a) }) {
  if (!SHEET_URL.test(url || '')) throw new SheetError('Paste the web app URL from Apps Script (it ends in /exec).');
  if (!secret) throw new SheetError('Paste the secret from the setup step.');
  return {
    /** Sends to-do/Duet actions (or none, to just read) and returns the sheet's tasks and questions. */
    async sync(actions = []) {
      let res;
      try {
        // No Content-Type header: a text/plain body keeps this a "simple" request, which Apps Script accepts cross-origin.
        res = await fetchImpl(url, { method: 'POST', body: JSON.stringify({ secret, actions: actions.filter(isSheetAction) }) });
      } catch {
        throw new SheetError('Can’t reach the Google Sheet. Check the internet connection.');
      }
      if (!res.ok) throw new SheetError(`Google Sheet error (${res.status}).`);
      let data;
      try { data = await res.json(); } catch { throw new SheetError('The sheet didn’t send data back. Check the web app is deployed with access for “Anyone”.'); }
      if (data.error) throw new SheetError(data.error === 'Unauthorized' ? 'The sheet rejected the secret.' : `Sheet: ${str(data.error, 100)}`);
      return {
        items: normalizeTodoItems((Array.isArray(data.items) ? data.items : []).map((i) => ({ text: i?.text, done: !!i?.done }))),
        // null = the sheet's script predates "Duet, …" and needs redeploying (it ignores questions)
        questions: Array.isArray(data.questions) ? normalizeQuestions(data.questions) : null,
      };
    },
  };
}
