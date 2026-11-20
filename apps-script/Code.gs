/**
 * Voice Dashboard <-> Google Sheet bridge.
 *
 * The sheet holds the to-do list: row 1 is the header (Task | Done), then one task per row.
 * Claude Duet (or you) can edit the rows directly; the dashboard reads and changes them through this web app.
 *
 * Setup (once):
 *   1. In the sheet: Extensions -> Apps Script, replace everything with this file, save.
 *   2. Choose the function "setup" and press Run. Allow access. Copy the secret from the execution log.
 *   3. Deploy -> New deployment -> type "Web app". Execute as: Me. Who has access: Anyone. Deploy, copy the URL.
 *   4. On the dashboard: Settings -> Google Sheet -> paste the URL and the secret.
 *
 * "Anyone" means anyone with the URL can reach this script, but every request must carry the secret,
 * and the script can only add, tick, untick and remove tasks in this one sheet.
 */
var HEADER = ['Task', 'Done'];
var MAX_TASKS = 60;

function setup() {
  getSheet_();
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid();
    props.setProperty('SECRET', secret);
  }
  Logger.log('Dashboard secret: ' + secret);
  return secret;
}

function doGet() {
  return json_({ ok: true, message: 'Voice Dashboard sheet bridge. Send a POST with the secret.' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'Bad request' });
  }
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || typeof body.secret !== 'string' || body.secret !== secret) return json_({ error: 'Unauthorized' });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_();
    applyActions_(sheet, Array.isArray(body.actions) ? body.actions.slice(0, 20) : []);
    return json_({ items: readTasks_(sheet).map(function (t) { return { text: t.text, done: t.done }; }) });
  } finally {
    lock.releaseLock();
  }
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('To-do') || ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function isDone_(v) {
  return v === true || /^(x|yes|y|true|done|✓|✔)$/i.test(String(v).trim());
}

function clean_(t) {
  return String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 120);
}

function readTasks_(sheet) {
  var values = sheet.getDataRange().getValues();
  var tasks = [];
  for (var i = 1; i < values.length; i++) {
    var text = clean_(values[i][0]);
    if (text) tasks.push({ row: i + 1, text: text, done: isDone_(values[i][1]) });
  }
  return tasks;
}

// An exact (case-insensitive) match wins over a partial one, so "milk" never ticks "oat milk" by mistake.
function match_(tasks, phrase) {
  var m = clean_(phrase).toLowerCase();
  if (!m) return null;
  var exact = tasks.filter(function (t) { return t.text.toLowerCase() === m; })[0];
  if (exact) return exact;
  return tasks.filter(function (t) { var x = t.text.toLowerCase(); return x.indexOf(m) >= 0 || m.indexOf(x) >= 0; })[0] || null;
}

function applyActions_(sheet, actions) {
  actions.forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    var tasks = readTasks_(sheet);
    if (a.op === 'todo_add') {
      var texts = (Array.isArray(a.items) ? a.items : [a.text]).map(clean_).filter(Boolean);
      texts.slice(0, Math.max(0, MAX_TASKS - tasks.length)).forEach(function (text) {
        sheet.appendRow([text, false]);
        sheet.getRange(sheet.getLastRow(), 2).insertCheckboxes();
      });
    } else if (a.op === 'todo_done') {
      var t = match_(tasks, a.match);
      if (t) {
        var cell = sheet.getRange(t.row, 2);
        cell.insertCheckboxes();
        cell.setValue(a.done !== false);
      }
    } else if (a.op === 'todo_remove') {
      var r = match_(tasks, a.match);
      if (r) sheet.deleteRow(r.row);
    } else if (a.op === 'todo_clear_done') {
      tasks.filter(function (x) { return x.done; })
        .map(function (x) { return x.row; })
        .sort(function (p, q) { return q - p; })
        .forEach(function (row) { sheet.deleteRow(row); });
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
