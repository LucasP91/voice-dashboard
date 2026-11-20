// Runs apps-script/Code.gs in Node against an in-memory fake sheet, for tests and the local mock.
import fs from 'node:fs';
import vm from 'node:vm';

export function loadBridge({ rows = [], secret = 'test-secret' } = {}) {
  const data = rows.map((r) => [...r]);
  const props = new Map(secret ? [['SECRET', secret]] : []);
  const sheet = {
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
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === 'To-do' ? sheet : null), getSheets: () => [sheet] }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
    Utilities: { getUuid: () => 'uuid-1234' },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body);
  return { ctx, data, props, post };
}
