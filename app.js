// Voice dashboard client. Static site: state lives in this device's localStorage.
// All stored/model-provided text is inserted with textContent (never innerHTML).
import { applyActions, askClaude, localParse, normalizeAll } from './logic.js';

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const empty = $('#empty');
const transcript = $('#transcript');
const mic = $('#mic');
const input = $('#command-input');
const form = $('#command-form');
const sendBtn = $('#send');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const EXAMPLES = ['Add milk to my to-do list', 'Timer for 5 minutes', 'Weather in London', 'Add a clock', 'Note: call the dentist'];
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
function card(w, extraClass, ...body) {
  const label = w.title || w.type[0].toUpperCase() + w.type.slice(1);
  return el('section', { class: `card ${extraClass || ''}`.trim(), 'data-id': w.id, 'aria-label': label },
    el('div', { class: 'card-head' },
      el('h2', { class: 'card-title', text: label }),
      el('button', { class: 'card-remove', type: 'button', 'aria-label': `Remove ${label}`, text: '✕', onclick: () => mutate(() => { widgets = widgets.filter((x) => x.id !== w.id); }) }),
    ),
    ...body,
  );
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
    widgets = applyActions(widgets, [{ op: 'todo_add', items: [text] }]);
    save(); render();
  } }, addInput, el('button', { class: 'btn btn-primary', type: 'submit', text: 'Add' }));

  const list = w.items.length
    ? el('ul', { class: 'todo-list' }, ...w.items.map((item) => el('li', { class: 'todo-item' },
      checkButton(item.text, item.done, () => mutate(() => { item.done = !item.done; })),
      el('button', { class: 'todo-del', type: 'button', 'aria-label': `Delete ${item.text}`, text: '✕', onclick: () => mutate(() => { w.items = w.items.filter((i) => i !== item); }) }),
    )))
    : el('p', { class: 'todo-empty', text: 'Nothing to do. Say “add milk to my to-do list”.' });

  return card(w, 'todo-card', body(list),
    el('div', { class: 'todo-foot' },
      el('span', { text: `${left} to do` }),
      doneCount ? el('button', { class: 'btn', type: 'button', text: `Clear ${doneCount} done`, onclick: () => mutate(() => { w.items = w.items.filter((i) => !i.done); }) }) : null,
    ),
    addForm,
  );
}

const buildWeather = (w) => card(w, '', body(el('div', { class: 'big', 'data-weather': w.city, text: '…' }), el('div', { class: 'sub', 'data-weather-sub': w.city, text: w.city })));

const BUILDERS = { clock: buildClock, timer: buildTimer, note: buildNote, checklist: buildChecklist, weather: buildWeather, todo: buildTodo };

function render() {
  grid.replaceChildren(...widgets.map((w) => BUILDERS[w.type]?.(w)).filter(Boolean));
  empty.hidden = widgets.length > 0;
  if (refocusTodo) { refocusTodo = false; $('#todo-input')?.focus(); }
  tick();
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

$('#open-settings').addEventListener('click', () => {
  keyInput.value = getKey();
  modelInput.value = getModel();
  auroraToggle.checked = store.get('vd:aurora', 'on') !== 'off';
  dialog.showModal();
});
$('#clear-key').addEventListener('click', () => { store.del('vd:key'); keyInput.value = ''; syncChip(); setTranscript('Claude key removed.'); });
$('#settings-form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return; // Close button just closes
  const key = keyInput.value.trim();
  if (key) store.set('vd:key', key); else store.del('vd:key');
  store.set('vd:model', modelInput.value.trim() || DEFAULT_MODEL);
  store.set('vd:aurora', auroraToggle.checked ? 'on' : 'off');
  applyAurora();
  syncChip();
  setTranscript(key ? 'Settings saved.' : 'Settings saved. Using built-in commands.');
});

// ---------- commands ----------
async function interpret(text) {
  const apiKey = getKey();
  if (apiKey) {
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
    widgets = applyActions(widgets, actions);
    save();
    render();
    setTranscript(reply);
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
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let heard = '';

function setListening(on) {
  listening = on;
  mic.setAttribute('aria-pressed', String(on));
  mic.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
}

function setupVoice() {
  if (!Recognition) {
    mic.hidden = true;
    setTranscript('Voice input isn’t available in this browser. Type a command instead.');
    return;
  }
  recognizer = new Recognition();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;

  recognizer.onstart = () => { heard = ''; setListening(true); setTranscript('Listening…'); };
  recognizer.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    heard = finalText || heard;
    setTranscript(`“${(finalText || interim).trim()}”`);
  };
  recognizer.onerror = (e) => {
    setListening(false);
    const messages = {
      'not-allowed': 'Microphone is blocked. Allow it in Settings → Safari → Microphone.',
      'service-not-allowed': 'Speech recognition is turned off. Enable Dictation in Settings → General → Keyboard.',
      'no-speech': 'I didn’t hear anything. Tap the mic and try again.',
      'audio-capture': 'No microphone found.',
    };
    setTranscript(messages[e.error] || `Voice input stopped (${e.error}).`);
  };
  recognizer.onend = () => {
    setListening(false);
    const text = heard.trim();
    heard = '';
    if (text) sendCommand(text);
  };
}

mic.addEventListener('click', () => {
  if (!recognizer) return;
  if (listening) { recognizer.stop(); return; }
  try { recognizer.start(); } catch { /* already starting */ }
});

// ---------- boot ----------
$('#examples').replaceChildren(...EXAMPLES.map((text) => el('li', {}, el('button', { class: 'btn', type: 'button', text, onclick: () => sendCommand(text) }))));

// Keep the screen awake (iPadOS 16.4+). The lock is released when the page is hidden, so re-request on return.
async function keepAwake() {
  try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch { /* not allowed right now */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

applyAurora();
syncChip();
setupVoice();
keepAwake();
render();
setInterval(tick, 1000);
