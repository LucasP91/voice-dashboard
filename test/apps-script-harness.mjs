// Runs apps-script/Code.gs in Node against in-memory fake sheets, for tests and the local mock.
import fs from 'node:fs';
import vm from 'node:vm';

function makeSheet(name, data) {
  return {
    name,
    data,
    getName: () => name,
    getLastRow: () => data.length,
    getDataRange: () => ({ getValues: () => data.map((r) => [...r]) }),
    appendRow: (r) => { data.push([...r]); },
    deleteRow: (n) => { data.splice(n - 1, 1); },
    setFrozenRows() {},
    getRange: (row, col) => ({
      setValues(vals) { vals.forEach((v, i) => { data[row - 1 + i] ??= []; v.forEach((x, j) => { data[row - 1 + i][col - 1 + j] = x; }); }); return this; },
      setValue(v) { data[row - 1] ??= []; data[row - 1][col - 1] = v; return this; },
      insertCheckboxes() { const r = data[row - 1]; if (r && typeof r[col - 1] !== 'boolean') r[col - 1] = false; return this; },
    }),
  };
}

/**
 * rows: the to-do tab (first tab, named "Sheet1"). questions: rows for a "Questions" tab, or null for none yet.
 * insertAt: where insertSheet puts a new tab when no index is given (0 = front, to catch code that relies on order).
 */
export function loadBridge({ rows = [], questions = null, secret = 'test-secret' } = {}) {
  const sheets = [makeSheet('Sheet1', rows.map((r) => [...r]))];
  if (questions) sheets.push(makeSheet('Questions', questions.map((r) => [...r])));
  const props = new Map(secret ? [['SECRET', secret]] : []);
  const ss = {
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => [...sheets],
    insertSheet: (name, index = 0) => { const s = makeSheet(name, []); sheets.splice(index, 0, s); return s; },
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => 'uuid-1234' },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body);
  return {
    ctx, props, post, sheets,
    get data() { return sheets.find((s) => s.name === 'Sheet1').data; },
    tab: (name) => sheets.find((s) => s.name === name)?.data ?? null,
  };
}
