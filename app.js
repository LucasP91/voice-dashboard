// Voice dashboard client. Static site: state lives in this device's localStorage.
// All stored/model-provided text is inserted with textContent (never innerHTML).
import { applyActions, askClaude, isDuetCommand, isSheetAction, isTodoAction, localParse, normalizeAll, sheetClient } from './logic.js?v=__BUILD__';

// Safari before 14 lacks replaceChildren, which every render uses.
if (!Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); };
}

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const empty = $('#empty');
const transcript = $('#transcript');
const mic = $('#mic');
const input = $('#command-input');
const form = $('#command-form');
const sendBtn = $('#send');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const EXAMPLES = ['Add milk to my to-do list', 'Duet, plan my weekend', 'Timer for 5 minutes', 'Weather in London', 'Add a clock', 'Note: call the dentist'];
const FAHRENHEIT = /^en-US/i.test(navigator.language);

// ---------- storage (every access guarded: it can throw in private windows) ----------
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let widgets = [];
try { widgets = normalizeAll(JSON.parse(store.get('vd:widgets', '[]'))); } catch { widgets = []; }
const weatherCache = new Map(); // city -> { temp, text, ts, loading }
const finishedTimers = new Set();
let refocusTodo = false;

function save() { store.set('vd:widgets', JSON.stringify(widgets)); }
function mutate(fn) { fn(); save(); render(); }

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...kids.filter(Boolean));
  return node;
}
const setTranscript = (text) => { transcript.textContent = text; };

// ---------- widgets ----------
const seenIds = new Set(); // only cards that are new get the entrance animation, not every re-render
let arrangingId = null;    // the card currently showing its ◀ ▶ move buttons

function gripIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'currentColor');
  for (const [cx, cy] of [[9, 6], [15, 6], [9, 12], [15, 12], [9, 18], [15, 18]]) {
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', '1.7');
    svg.append(dot);
  }
  return svg;
}

const labelOf = (w) => w.title || w.type[0].toUpperCase() + w.type.slice(1);

function card(w, extraClass, ...body) {
  const label = labelOf(w);
  const index = widgets.findIndex((x) => x.id === w.id);
  const arranging = arrangingId === w.id;
  const isNew = !seenIds.has(w.id);
  seenIds.add(w.id);

  // Drag the handle to move the card; tap it (or press Enter) for ◀ ▶ buttons; arrow keys move it too.
  const handle = el('button', {
    class: 'card-handle', type: 'button', 'data-handle': w.id, 'aria-expanded': String(arranging),
    'aria-label': `Move ${label}`, title: 'Drag to move, or tap for move buttons',
    onpointerdown: (e) => startDrag(e, w.id),
    onkeydown: (e) => keyMove(e, w.id),
    onclick: () => {
      if (suppressClick) { suppressClick = false; return; }
      arrangingId = arranging ? null : w.id;
      focusAfterRender = `[data-handle="${w.id}"]`;
      render();
    },
  }, gripIcon());

  const moveBtn = (to, icon, name, disabled) => el('button', {
    class: 'btn move-btn', type: 'button', 'data-move': to, 'aria-label': `Move ${label} ${name}`, text: icon,
    ...(disabled ? { disabled: '' } : {}),
    onclick: () => moveWidget(w.id, to),
  });

  const head = arranging
    ? el('div', { class: 'card-head' }, handle,
      el('div', { class: 'move-buttons', role: 'group', 'aria-label': `Move ${label}` },
        moveBtn('earlier', '◀', 'earlier', index === 0),
        moveBtn('later', '▶', 'later', index === widgets.length - 1),
        el('button', { class: 'btn btn-primary', type: 'button', text: 'Done', onclick: () => { arrangingId = null; focusAfterRender = `[data-handle="${w.id}"]`; render(); } }),
      ))
    : el('div', { class: 'card-head' }, handle,
      el('h2', { class: 'card-title', text: label }),
      el('button', { class: 'card-remove', type: 'button', 'aria-label': `Remove ${label}`, text: '✕', onclick: () => mutate(() => { widgets = widgets.filter((x) => x.id !== w.id); if (w.type === 'todo' || w.type === 'duet') store.set(`vd:${w.type}-hidden`, '1'); }) }));

  const classes = ['card', extraClass, isNew && 'enter', arranging && 'arranging'].filter(Boolean).join(' ');
  return el('section', { class: classes, 'data-id': w.id, 'aria-label': label }, head, ...body);
}
const body = (...kids) => el('div', { class: 'card-body' }, ...kids);

function fmtDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
const timerRemaining = (w) => (w.endsAt ? w.endsAt - Date.now() : w.remainingMs);

function buildClock(w) {
  return card(w, '', body(el('div', { class: 'big', 'data-clock-time': '' }), el('div', { class: 'sub', 'data-clock-date': '' })));
}

function buildTimer(w) {
  const running = !!w.endsAt;
  const done = !running && w.remainingMs <= 0;
  const c = card(w, done ? 'done' : '',
    body(
      el('div', { class: 'big', 'data-timer': w.id, role: 'timer' }),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn-primary', type: 'button', text: running ? 'Pause' : done ? 'Restart' : 'Start',
          onclick: () => mutate(() => {
            finishedTimers.delete(w.id);
            if (running) { w.remainingMs = Math.max(0, w.endsAt - Date.now()); w.endsAt = null; }
            else { if (w.remainingMs <= 0) w.remainingMs = w.seconds * 1000; w.endsAt = Date.now() + w.remainingMs; }
          }),
        }),
        el('button', { class: 'btn', type: 'button', text: 'Reset', onclick: () => mutate(() => { finishedTimers.delete(w.id); w.endsAt = null; w.remainingMs = w.seconds * 1000; }) }),
      ),
    ),
  );
  return c;
}

const buildNote = (w) => card(w, '', body(el('p', { class: 'note-text', text: w.text })));

function checkButton(text, done, onclick) {
  return el('button', { class: 'check', type: 'button', role: 'checkbox', 'aria-checked': String(done), onclick },
    el('span', { class: 'check-box', 'aria-hidden': 'true', text: '✓' }), el('span', { class: 'check-label', text }));
}

const buildChecklist = (w) => card(w, '', body(...w.items.map((item) => checkButton(item.text, item.done, () => mutate(() => { item.done = !item.done; })))));

function buildTodo(w) {
  const left = w.items.filter((i) => !i.done).length;
  const doneCount = w.items.length - left;
  const addInput = el('input', { class: 'input', type: 'text', id: 'todo-input', 'aria-label': 'New task', placeholder: 'Add a task', maxlength: '120', autocomplete: 'off', enterkeyhint: 'done' });
  const addForm = el('form', { class: 'todo-add', onsubmit: (e) => {
    e.preventDefault();
    const text = addInput.value.trim();
    if (!text) return;
    refocusTodo = true;
    addInput.value = '';
    runActions([{ op: 'todo_add', items: [text] }]);
  } }, addInput, el('button', { class: 'btn btn-primary', type: 'submit', text: 'Add' }));

  const list = w.items.length
    ? el('ul', { class: 'todo-list' }, ...w.items.map((item) => el('li', { class: 'todo-item' },
      checkButton(item.text, item.done, () => runActions([{ op: 'todo_done', match: item.text, done: !item.done }])),
      el('button', { class: 'todo-del', type: 'button', 'aria-label': `Delete ${item.text}`, text: '✕', onclick: () => runActions([{ op: 'todo_remove', match: item.text }]) }),
    )))
    : el('p', { class: 'todo-empty', text: 'Nothing to do. Say “add milk to my to-do list”.' });

  return card(w, 'todo-card', body(list),
    el('div', { class: 'todo-foot' },
      el('span', { class: 'todo-count' }, `${left} to do`, el('span', { id: 'todo-sync', class: 'todo-sync', role: 'status', text: syncLabel() })),
      doneCount ? el('button', { class: 'btn', type: 'button', text: `Clear ${doneCount} done`, onclick: () => runActions([{ op: 'todo_clear_done' }]) }) : null,
    ),
    addForm,
  );
}

const buildWeather = (w) => card(w, '', body(el('div', { class: 'big', 'data-weather': w.city, text: '…' }), el('div', { class: 'sub', 'data-weather-sub': w.city, text: w.city })));

/** "5 min ago", "yesterday", or a date, for when a question was asked. */
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildDuet(w) {
  const list = w.items.length
    ? el('ul', { class: 'duet-list' }, ...[...w.items].reverse().map((q) => el('li', { class: `duet-item${q.answer ? ' answered' : ''}` },
      el('div', { class: 'duet-q' },
        el('p', { class: 'duet-q-text', text: q.text }),
        el('button', { class: 'todo-del', type: 'button', 'aria-label': `Delete question: ${q.text}`, text: '✕', onclick: () => runActions([{ op: 'duet_remove', match: q.text }]) })),
      q.answer
        ? el('p', { class: 'duet-a', text: q.answer })
        : el('p', { class: 'duet-wait', 'data-asked': q.asked, text: `Waiting for Duet · asked ${ago(q.asked)}` }),
    )))
    : el('p', { class: 'todo-empty', text: 'Say “Duet,” then a question or request. Answers show up here.' });
  return card(w, 'duet-card', body(list),
    el('p', { class: 'duet-foot', text: sheet ? 'Duet answers when it checks your Google Sheet.' : 'Connect the Google Sheet in Settings so Duet can see these.' }));
}

const BUILDERS = { clock: buildClock, timer: buildTimer, note: buildNote, checklist: buildChecklist, weather: buildWeather, todo: buildTodo, duet: buildDuet };

function render() {
  // Never rebuild the cards mid-drag (a sheet sync or timer could fire); do it once the card has landed.
  if (drag?.active || settling) { renderQueued = true; return; }
  renderQueued = false;
  // Keep a half-typed task and its focus across re-renders (sheet polling re-renders the card).
  const typing = $('#todo-input');
  const draft = typing?.value || '';
  const hadFocus = !!typing && document.activeElement === typing;
  grid.replaceChildren(...widgets.map((w) => BUILDERS[w.type]?.(w)).filter(Boolean));
  empty.hidden = widgets.length > 0;
  const todoInput = $('#todo-input');
  if (todoInput && draft && !refocusTodo) todoInput.value = draft;
  if (todoInput && (refocusTodo || hadFocus)) todoInput.focus();
  refocusTodo = false;
  if (focusAfterRender) {
    // first selector that matches wins (a comma list would pick whichever comes first in the page)
    const target = [].concat(focusAfterRender).map((sel) => grid.querySelector(sel)).find(Boolean);
    target?.focus();
    focusAfterRender = null;
  }
  tick();
}

// ---------- moving cards ----------
const DRAG_START_PX = 8;     // finger travel before a press on the handle becomes a drag
const SETTLE_MS = 200;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let drag = null;             // { id, pointerId, startX, startY, grabX, grabY, cardEl, handle, active }
let settling = false;
let renderQueued = false;
let suppressClick = false;   // a drag ends with a click on the handle; don't treat it as a tap
let focusAfterRender = null;

function announceMove(id) {
  const i = widgets.findIndex((w) => w.id === id);
  const w = widgets[i];
  setTranscript(`Moved ${labelOf(w)} to position ${i + 1} of ${widgets.length}.`);
}

function moveWidget(id, to) {
  const before = widgets.map((w) => w.id).join();
  widgets = applyActions(widgets, [{ op: 'move', id, to }]);
  if (widgets.map((w) => w.id).join() === before) return;
  save();
  // keep focus on the button that was pressed, or the other one if this end is reached
  focusAfterRender = [`[data-id="${id}"] [data-move="${to}"]:not([disabled])`, `[data-id="${id}"] [data-move]:not([disabled])`, `[data-handle="${id}"]`];
  render();
  announceMove(id);
}

function keyMove(e, id) {
  const to = { ArrowLeft: 'earlier', ArrowUp: 'earlier', ArrowRight: 'later', ArrowDown: 'later', Home: 'first', End: 'last' }[e.key];
  if (!to) return;
  e.preventDefault();
  moveWidget(id, to);
  focusAfterRender = null;
  grid.querySelector(`[data-handle="${id}"]`)?.focus();
}

function startDrag(e, id) {
  if (drag || settling || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const handle = e.currentTarget;
  drag = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, cardEl: handle.closest('.card'), handle, active: false };
  try { handle.setPointerCapture(e.pointerId); } catch { /* older Safari */ }
  handle.addEventListener('pointermove', onDragMove);
  handle.addEventListener('pointerup', onDragEnd);
  handle.addEventListener('pointercancel', onDragCancel);
}

function cardUnder(x, y) {
  return [...grid.children].find((c) => {
    if (c === drag.cardEl || c.dataset.flipping) return false; // ignore cards still sliding out of the way
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
}

function followPointer(x, y) {
  const c = drag.cardEl;
  c.style.transform = '';
  const r = c.getBoundingClientRect();
  c.style.transform = `translate(${x - drag.grabX - r.left}px, ${y - drag.grabY - r.top}px) scale(1.02)`;
}

/** Reorders the DOM, then slides the other cards from their old spots to the new ones (FLIP). */
function flip(change) {
  const others = [...grid.children].filter((c) => c !== drag.cardEl);
  const before = new Map(others.map((c) => [c, c.getBoundingClientRect()]));
  change();
  if (reducedMotion()) return;
  for (const c of others) {
    const a = before.get(c);
    const b = c.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    c.dataset.flipping = '1';
    c.style.transition = 'none';
    c.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      c.style.transition = `transform ${SETTLE_MS}ms var(--ease-out)`;
      c.style.transform = '';
    }));
    setTimeout(() => { delete c.dataset.flipping; c.style.transition = ''; }, SETTLE_MS + 40);
  }
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_START_PX) return;
    const r = drag.cardEl.getBoundingClientRect();
    drag.grabX = drag.startX - r.left;
    drag.grabY = drag.startY - r.top;
    drag.active = true;
    drag.cardEl.classList.add('dragging');
    document.documentElement.classList.add('is-dragging');
  }
  e.preventDefault();
  const over = cardUnder(e.clientX, e.clientY);
  if (over) {
    const cards = [...grid.children];
    const from = cards.indexOf(drag.cardEl);
    const to = cards.indexOf(over);
    flip(() => grid.insertBefore(drag.cardEl, from < to ? over.nextSibling : over));
  }
  followPointer(e.clientX, e.clientY);
}

function endDrag() {
  const d = drag;
  d.handle.removeEventListener('pointermove', onDragMove);
  d.handle.removeEventListener('pointerup', onDragEnd);
  d.handle.removeEventListener('pointercancel', onDragCancel);
  try { d.handle.releasePointerCapture(d.pointerId); } catch { /* already released */ }
  document.documentElement.classList.remove('is-dragging');
  drag = null;
  return d;
}

function land(cardEl, then) {
  settling = true;
  cardEl.style.transition = reducedMotion() ? 'none' : `transform ${SETTLE_MS}ms var(--ease-out)`;
  cardEl.style.transform = '';
  setTimeout(() => {
    cardEl.classList.remove('dragging');
    cardEl.style.transition = '';
    settling = false;
    then?.();
    if (renderQueued) render();
  }, reducedMotion() ? 0 : SETTLE_MS);
}

function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = endDrag();
  if (!d.active) return; // just a tap: the click handler shows the move buttons
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  // New order = the cards as dropped, plus any widget a command added mid-drag (not on screen yet).
  const order = [...grid.children].map((c) => c.dataset.id);
  const onScreen = new Set(order);
  const before = widgets.map((w) => w.id).join();
  widgets = [...order.map((id) => widgets.find((w) => w.id === id)).filter(Boolean), ...widgets.filter((w) => !onScreen.has(w.id))];
  const moved = widgets.map((w) => w.id).join() !== before;
  if (moved) save();
  land(d.cardEl, () => { if (moved) { renderQueued = true; announceMove(d.id); } });
}

function onDragCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = endDrag();
  if (!d.active) return;
  land(d.cardEl, () => { renderQueued = true; }); // put the cards back in the saved order
}

// ---------- once-a-second updates ----------
const WEATHER_TEXT = [[0, 'Clear'], [2, 'Partly cloudy'], [3, 'Overcast'], [48, 'Fog'], [57, 'Drizzle'], [67, 'Rain'], [77, 'Snow'], [82, 'Showers'], [86, 'Snow showers'], [99, 'Thunderstorm']];
const describeWeather = (code) => (WEATHER_TEXT.find(([max]) => code <= max) || [0, 'Unknown'])[1];

async function loadWeather(city) {
  const cached = weatherCache.get(city);
  if (cached && (cached.loading || Date.now() - cached.ts < 600_000)) return;
  weatherCache.set(city, { ...cached, loading: true, ts: cached?.ts ?? 0 });
  try {
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)).json();
    const place = geo.results?.[0];
    if (!place) throw new Error('City not found');
    const unit = FAHRENHEIT ? '&temperature_unit=fahrenheit' : '';
    const wx = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&timezone=auto${unit}`)).json();
    weatherCache.set(city, { ts: Date.now(), temp: `${Math.round(wx.current.temperature_2m)}°${FAHRENHEIT ? 'F' : 'C'}`, text: `${describeWeather(wx.current.weather_code)} · ${place.name}` });
  } catch (err) {
    weatherCache.set(city, { ts: Date.now() - 540_000, temp: '–', text: err.message === 'City not found' ? `No match for “${city}”` : 'Weather unavailable' });
  }
  tick();
}

function tick() {
  const now = new Date();
  for (const node of document.querySelectorAll('[data-clock-time]')) node.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  for (const node of document.querySelectorAll('[data-clock-date]')) node.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  for (const node of document.querySelectorAll('[data-asked]')) {
    const text = `Waiting for Duet · asked ${ago(node.dataset.asked)}`;
    if (node.textContent !== text) node.textContent = text;
  }

  for (const w of widgets) {
    if (w.type === 'timer') {
      const node = document.querySelector(`[data-timer="${CSS.escape(w.id)}"]`);
      const remaining = timerRemaining(w);
      if (node) node.textContent = remaining <= 0 ? 'Done' : fmtDuration(remaining);
      if (w.endsAt && remaining <= 0 && !finishedTimers.has(w.id)) {
        finishedTimers.add(w.id);
        mutate(() => { w.endsAt = null; w.remainingMs = 0; });
        setTranscript(`${w.title || 'Timer'} finished.`);
      }
    } else if (w.type === 'weather') {
      loadWeather(w.city);
      const info = weatherCache.get(w.city);
      const big = document.querySelector(`[data-weather="${CSS.escape(w.city)}"]`);
      const sub = document.querySelector(`[data-weather-sub="${CSS.escape(w.city)}"]`);
      if (info?.temp && big) { big.textContent = info.temp; sub.textContent = info.text; }
    }
  }
}

// ---------- to-do sync with a Google Sheet ----------
// Changes show on screen at once. To-do actions queue up and go to the sheet in order; unsent ones are kept
// (also across reloads) and retried, so a dropped connection doesn't lose a tick or a new task.
const SHEET_POLL_MS = 60_000;
let sheet = null;
let pending = [];
try { pending = JSON.parse(store.get('vd:sheet-pending', '[]')).filter(isSheetAction); } catch { pending = []; }
let syncing = false;
let syncAgain = false;
let syncStatus = { state: 'off', text: '' };

function getSheetConfig() { try { return JSON.parse(store.get('vd:sheet', 'null')); } catch { return null; } }
function savePending() { store.set('vd:sheet-pending', JSON.stringify(pending)); }

function syncLabel() {
  if (!sheet) return '';
  return { busy: 'Syncing…', ok: 'Sheet synced', error: `⚠ ${syncStatus.text}` }[syncStatus.state] || '';
}
function setSyncStatus(state, text = '') {
  syncStatus = { state, text };
  const node = $('#todo-sync');
  if (node) node.textContent = syncLabel();
  syncSheetChip();
}

/** Top-bar chip: is the Google Sheet connected and working? Tapping it opens Settings. */
function syncSheetChip() {
  const chip = $('#sheet-chip');
  if (!chip) return;
  const state = !sheet ? 'off' : syncStatus.state === 'error' ? 'error' : syncStatus.state === 'ok' ? 'ok' : 'busy';
  chip.dataset.state = state;
  chip.textContent = { off: 'Sheet: not connected', ok: 'Sheet synced', busy: 'Sheet: syncing…', error: '⚠ Sheet problem' }[state];
  chip.setAttribute('aria-label', `${chip.textContent}${state === 'error' ? `: ${syncStatus.text.replace(/.$/, '')}` : ''}. Open settings.`);
  chip.title = state === 'error' ? syncStatus.text : '';
}

/** The one way the dashboard changes: update the screen now, then send any to-do changes to the sheet. */
function runActions(actions) {
  widgets = applyActions(widgets, actions);
  for (const type of ['todo', 'duet']) if (widgets.some((w) => w.type === type)) store.del(`vd:${type}-hidden`); // asked for it again
  // a To-do or Duet card that was just added should fill from the sheet now, not at the next poll
  if (sheet && (actions || []).some((a) => a.op === 'add' && (a.widget?.type === 'todo' || a.widget?.type === 'duet'))) syncSheet();
  save();
  render();
  const sheetOps = (actions || []).filter(isSheetAction);
  if (sheet && sheetOps.length) {
    pending.push(...sheetOps);
    savePending();
    syncSheet();
  }
}

function applySheetState({ items, questions }) {
  let changed = false;
  // Show the To-do / Duet card when the sheet has something for it, unless that card was removed on purpose.
  const ensureCard = (type, hasContent) => {
    if (!hasContent || widgets.some((w) => w.type === type) || store.get(`vd:${type}-hidden`) === '1') return;
    widgets = applyActions(widgets, [{ op: 'add', widget: { type } }]);
    changed = true;
  };
  ensureCard('todo', items.length > 0);
  if (questions) ensureCard('duet', questions.length > 0);

  const todo = widgets.find((w) => w.type === 'todo');
  const todoKey = (list) => JSON.stringify(list.map((i) => [i.text, i.done]));
  if (todo && todoKey(todo.items) !== todoKey(items)) { todo.items = items; changed = true; }

  const duet = questions && widgets.find((w) => w.type === 'duet'); // null questions: old script, leave the card alone
  const qKey = (list) => JSON.stringify(list.map((q) => [q.text, q.answer]));
  if (duet && qKey(duet.items) !== qKey(questions)) {
    const waiting = new Set(duet.items.filter((q) => !q.answer).map((q) => q.text)); // new card: empty, so no "answered" notice
    const fresh = questions.filter((q) => q.answer && waiting.has(q.text));
    duet.items = questions;
    changed = true;
    if (fresh.length) setTranscript(fresh.length === 1 ? `Duet answered: “${fresh[0].text}”` : `Duet answered ${fresh.length} questions.`);
  }
  if (changed) { save(); render(); }
}

async function syncSheet() {
  if (!sheet) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  const client = sheet;
  const batch = pending.slice(0, 20);
  setSyncStatus('busy');
  try {
    const state = await client.sync(batch);
    if (client !== sheet) return; // disconnected while waiting
    let rest = pending.slice(batch.length);
    const oldScript = state.questions === null;
    // An old sheet script ignores questions: keep them queued until it's updated, instead of losing them.
    if (oldScript) rest = [...batch.filter((a) => !isTodoAction(a)), ...rest];
    pending = rest;
    savePending();
    if (!pending.some(isTodoAction)) applySheetState(state); // with to-do changes still queued, the sheet's copy is out of date
    if (oldScript && pending.length) setSyncStatus('error', 'Update the sheet script to send “Duet,” questions (README → Updating the script).');
    else setSyncStatus('ok');
  } catch (err) {
    setSyncStatus('error', err.message);
  } finally {
    syncing = false;
    const more = syncAgain || (pending.length > 0 && syncStatus.state === 'ok');
    syncAgain = false;
    if (more) syncSheet();
  }
}

/** First connection: keep this iPad's unfinished tasks by copying the ones the sheet doesn't have. */
async function connectSheet() {
  const local = (widgets.find((w) => w.type === 'todo')?.items || []).filter((i) => !i.done).map((i) => i.text);
  const localQs = (widgets.find((w) => w.type === 'duet')?.items || []).filter((q) => !q.answer).map((q) => q.text);
  if (!widgets.some((w) => w.type === 'todo')) { widgets = applyActions(widgets, [{ op: 'add', widget: { type: 'todo' } }]); save(); render(); }
  setSyncStatus('busy');
  try {
    const remote = await sheet.sync([]);
    const have = new Set(remote.items.map((i) => i.text.toLowerCase()));
    const missing = local.filter((t) => !have.has(t.toLowerCase()));
    if (missing.length) { pending.push({ op: 'todo_add', items: missing }); savePending(); }
    const asked = new Set((remote.questions || []).map((q) => q.text.toLowerCase()));
    for (const text of localQs.filter((t) => !asked.has(t.toLowerCase()))) pending.push({ op: 'duet_ask', text });
    savePending();
    setTranscript(missing.length ? `Connected. Copied ${missing.length} task${missing.length > 1 ? 's' : ''} from this iPad to the sheet.` : 'Connected to the Google Sheet.');
  } catch (err) {
    setSyncStatus('error', err.message);
    setTranscript(`Couldn’t reach the sheet: ${err.message}`);
    return;
  }
  syncSheet();
}

function disconnectSheet() {
  sheet = null;
  pending = [];
  store.del('vd:sheet');
  store.del('vd:sheet-pending');
  setSyncStatus('off');
  render();
}

$('#sheet-chip').addEventListener('click', () => $('#open-settings').click());

// ---------- settings ----------
const dialog = $('#settings');
const keyInput = $('#api-key');
const modelInput = $('#model');
const auroraToggle = $('#aurora-toggle');
const getKey = () => store.get('vd:key', '');
const getModel = () => store.get('vd:model', '') || DEFAULT_MODEL;

function applyAurora() { document.documentElement.dataset.aurora = store.get('vd:aurora', 'on'); }

function syncChip() {
  const chip = $('#ai-chip');
  const ai = !!getKey();
  chip.textContent = ai ? 'Claude connected' : 'Built-in commands';
  chip.dataset.state = ai ? 'ai' : 'local';
}

const sheetUrlInput = $('#sheet-url');
const sheetSecretInput = $('#sheet-secret');
const sheetHint = $('#sheet-hint');

$('#open-settings').addEventListener('click', () => {
  keyInput.value = getKey();
  modelInput.value = getModel();
  auroraToggle.checked = store.get('vd:aurora', 'on') !== 'off';
  const cfg = getSheetConfig();
  sheetUrlInput.value = cfg?.url || '';
  sheetSecretInput.value = cfg?.secret || '';
  sheetHint.textContent = '';
  openSettings();
});

// <dialog> needs iPadOS 15.4+. On older Safari, show it as a fixed overlay instead, and close it
// ourselves (never through form method="dialog", which old Safari treats as a normal page submit).
const nativeDialog = typeof dialog.showModal === 'function';
function openSettings() {
  if (nativeDialog) dialog.showModal();
  else { dialog.setAttribute('open', ''); document.documentElement.classList.add('modal-fallback'); dialog.querySelector('input')?.focus(); }
}
function closeSettings() {
  if (nativeDialog) { if (dialog.open) dialog.close(); }
  else { dialog.removeAttribute('open'); document.documentElement.classList.remove('modal-fallback'); }
  $('#open-settings').focus();
}
$('#settings-x').addEventListener('click', closeSettings);
$('#settings-close').addEventListener('click', closeSettings);
dialog.addEventListener('click', (e) => { if (e.target === dialog) closeSettings(); }); // tap outside the panel
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !nativeDialog && dialog.hasAttribute('open')) closeSettings(); });
$('#clear-key').addEventListener('click', () => { store.del('vd:key'); keyInput.value = ''; syncChip(); setTranscript('Claude key removed.'); });
$('#disconnect-sheet').addEventListener('click', () => {
  sheetUrlInput.value = '';
  sheetSecretInput.value = '';
  disconnectSheet();
  sheetHint.textContent = 'Disconnected. The to-do list now stays on this iPad only.';
});
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault(); // Save is the only submit button; we close the panel ourselves
  sheetHint.textContent = '';

  // Check the sheet details first, so a typo keeps the dialog open with the reason.
  const url = sheetUrlInput.value.trim();
  const secret = sheetSecretInput.value.trim();
  const old = getSheetConfig();
  const sheetChanged = url !== (old?.url || '') || secret !== (old?.secret || '');
  if (sheetChanged && (url || secret)) {
    try {
      sheet = sheetClient({ url, secret });
    } catch (err) {
      e.preventDefault();
      sheetHint.textContent = err.message;
      return;
    }
    store.set('vd:sheet', JSON.stringify({ url, secret }));
    pending = [];
    savePending();
    connectSheet();
  } else if (sheetChanged) {
    disconnectSheet();
  }

  const key = keyInput.value.trim();
  if (key) store.set('vd:key', key); else store.del('vd:key');
  store.set('vd:model', modelInput.value.trim() || DEFAULT_MODEL);
  store.set('vd:aurora', auroraToggle.checked ? 'on' : 'off');
  applyAurora();
  syncChip();
  if (!sheetChanged) setTranscript(key ? 'Settings saved.' : 'Settings saved. Using built-in commands.');
  closeSettings();
});

// ---------- commands ----------
async function interpret(text) {
  const apiKey = getKey();
  if (apiKey && !isDuetCommand(text)) { // "Duet, …" always goes to Duet (your subscription), never the API
    try {
      return await askClaude({ apiKey, model: getModel(), text, widgets });
    } catch (err) {
      const fallback = localParse(text, widgets);
      return { ...fallback, reply: `${err.message} ${fallback.actions.length ? fallback.reply : 'Using built-in commands: ' + fallback.reply}` };
    }
  }
  return localParse(text, widgets);
}

async function sendCommand(text) {
  text = text.trim();
  if (!text) return;
  setTranscript(`“${text}”`);
  sendBtn.disabled = true;
  try {
    const { reply, actions } = await interpret(text);
    runActions(actions);
    const askedDuet = actions.some((a) => a.op === 'duet_ask');
    setTranscript(askedDuet && !sheet ? 'Saved on the Duet card. Connect the Google Sheet in Settings so Duet can see it.' : reply);
  } catch (err) {
    setTranscript(`Something went wrong: ${err.message}`);
  } finally {
    sendBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  input.blur();
  sendCommand(text);
});

// ---------- voice input ----------
// iPad Safari quirks handled here: results often never arrive marked "final", and listening may not stop
// by itself. So the latest words are kept, listening stops after a short pause, and whatever was heard is sent.
// Add ?debug to the address to see every speech event on screen.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const SILENCE_MS = 1500;   // stop this long after the last words
const MAX_LISTEN_MS = 15000;
const DEBUG_VOICE = /[?&]debug\b/.test(location.search);
let recognizer = null;
let listening = false;
let heard = '';
let gotError = false;
let silenceTimer = 0;
let maxTimer = 0;

function voiceLog(msg) {
  if (!DEBUG_VOICE) return;
  const log = $('#voice-log') || document.body.appendChild(el('pre', { id: 'voice-log', class: 'voice-log' }));
  log.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n${log.textContent}`.slice(0, 4000);
}

function setListening(on) {
  listening = on;
  mic.setAttribute('aria-pressed', String(on));
  mic.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
}

function stopListening() {
  clearTimeout(silenceTimer);
  clearTimeout(maxTimer);
  try { recognizer?.stop(); } catch { /* already stopped */ }
}

function setupVoice() {
  voiceLog(`speech API: ${Recognition ? 'yes' : 'no'} · home screen app: ${isHomeScreenApp} · ${navigator.userAgent}`);
  if (!Recognition) {
    // No web speech API here (older iPadOS, or some Home Screen web apps). The mic button then opens the
    // keyboard instead, whose own dictation key works everywhere.
    mic.setAttribute('aria-label', 'Dictate with the keyboard');
    return;
  }
  recognizer = new Recognition();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;
  recognizer.maxAlternatives = 1;

  for (const name of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch']) {
    recognizer.addEventListener(name, () => voiceLog(name));
  }

  recognizer.onstart = () => {
    heard = '';
    gotError = false;
    setListening(true);
    setTranscript('Listening… speak now, or tap the mic to stop.');
    voiceLog('start');
    clearTimeout(maxTimer);
    maxTimer = setTimeout(stopListening, MAX_LISTEN_MS);
  };
  recognizer.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    text = text.trim();
    const isFinal = !!e.results[e.results.length - 1]?.isFinal;
    voiceLog(`result${isFinal ? ' (final)' : ''}: ${text}`);
    if (text) { heard = text; setTranscript(`“${text}”`); }
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stopListening, isFinal ? 300 : SILENCE_MS);
  };
  recognizer.onerror = (e) => {
    voiceLog(`error: ${e.error}${e.message ? ` (${e.message})` : ''}`);
    if (e.error === 'aborted') return; // we stopped it ourselves
    gotError = true;
    const messages = {
      'not-allowed': 'The microphone was blocked. If you just allowed it, tap the mic again. Otherwise allow it in Settings → Safari → Microphone.',
      'service-not-allowed': 'Speech recognition is off. Turn on Settings → General → Keyboard → Enable Dictation, then try again.',
      'no-speech': 'I didn’t hear anything. Tap the mic and speak straight away.',
      'audio-capture': 'No microphone found.',
      network: 'Speech recognition needs an internet connection.',
    };
    setTranscript(messages[e.error] || `Voice input stopped (${e.error}). Tap the mic to try again.`);
  };
  recognizer.onend = () => {
    clearTimeout(silenceTimer);
    clearTimeout(maxTimer);
    voiceLog(`end · heard: "${heard}"`);
    setListening(false);
    const text = heard.trim();
    heard = '';
    if (text) sendCommand(text);
    else if (!gotError) setTranscript('I didn’t catch that. Tap the mic and speak straight away.');
  };
}

const isHomeScreenApp = navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;

mic.addEventListener('click', () => {
  if (!recognizer) {
    input.focus(); // must happen inside the tap, or iPadOS won't show the keyboard
    setTranscript(isHomeScreenApp
      ? 'Tap 🎤 on the keyboard, speak, then tap Send. (One-tap voice works when the dashboard is opened in Safari.)'
      : 'Tap 🎤 on the keyboard, speak, then tap Send.');
    return;
  }
  if (listening) { voiceLog('tap: stop'); stopListening(); return; }
  voiceLog('tap: start');
  setTranscript('Starting the mic…');
  try {
    recognizer.start();
  } catch (err) {
    // Safari can still be finishing the last session; reset it and try once more.
    voiceLog(`start failed: ${err.name}`);
    try { recognizer.abort(); } catch { /* ignore */ }
    setTimeout(() => {
      try { recognizer.start(); } catch { setTranscript('The mic is busy. Tap it again in a moment.'); }
    }, 300);
  }
});

// ---------- boot ----------
$('#examples').replaceChildren(...EXAMPLES.map((text) => el('li', {}, el('button', { class: 'btn', type: 'button', text, onclick: () => sendCommand(text) }))));

// Keep the screen awake (iPadOS 16.4+). The lock is released when the page is hidden, so re-request on return.
async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* not allowed right now */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); syncSheet(); }
});

applyAurora();
syncChip();
syncSheetChip();
setupVoice();
keepAwake();
try { const cfg = getSheetConfig(); if (cfg) sheet = sheetClient(cfg); } catch { store.del('vd:sheet'); }
render();
setInterval(tick, 1000);
syncSheet();
setInterval(() => { if (document.visibilityState === 'visible') syncSheet(); }, SHEET_POLL_MS);
