/**
 * Voice Dashboard <-> Google Sheet bridge.
 *
 * Two tabs:
 *   - the to-do list (the first tab, or one named "To-do"): Task | Done, one task per row.
 *   - "Questions" (created automatically): Question | Asked | Answer | Answered.
 *     Saying "Duet, ..." on the dashboard adds a row; Claude Duet fills in Answer (and Answered).
 * Claude Duet (or you) can edit the rows directly; the dashboard reads and changes them through this web app.
 *
 * Setup (once):
 *   1. In the sheet: Extensions -> Apps Script, replace everything with this file, save.
 *   2. Choose the function "setup" and press Run. Allow access. Copy the secret from the execution log.
 *   3. Deploy -> New deployment -> type "Web app". Execute as: Me. Who has access: Anyone. Deploy, copy the URL.
 *   4. On the dashboard: Settings -> Google Sheet -> paste the URL and the secret.
 * After changing this file later: Deploy -> Manage deployments -> Edit (pencil) -> Version: New version -> Deploy.
 * That keeps the same URL.
 *
 * "Anyone" means anyone with the URL can reach this script, but every request must carry the secret,
 * and the script can only add, tick, untick and remove tasks and questions in this one spreadsheet.
 */
var HEADER = ['Task', 'Done'];
var MAX_TASKS = 60;
var QUESTIONS = 'Questions';
var Q_HEADER = ['Question', 'Asked', 'Answer', 'Answered'];
var MAX_QUESTIONS_SHOWN = 20;

function setup() {
  getSheet_();
  getQuestions_(true);
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
    return json_({
      items: readTasks_(sheet).map(function (t) { return { text: t.text, done: t.done }; }),
      questions: readQuestions_(getQuestions_(false)).slice(-MAX_QUESTIONS_SHOWN).map(function (q) {
        return { text: q.text, asked: q.asked, answer: q.answer, answered: q.answered };
      }),
    });
  } finally {
    lock.releaseLock();
  }
}

// The to-do tab: one named "To-do", else the first tab that isn't Questions.
function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('To-do') || ss.getSheets().filter(function (s) { return s.getName() !== QUESTIONS; })[0];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 2).setValues([HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getQuestions_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(QUESTIONS);
  if (!sheet && create) sheet = ss.insertSheet(QUESTIONS, ss.getSheets().length); // added as the last tab
  if (sheet && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 4).setValues([Q_HEADER]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function isDone_(v) {
  return v === true || /^(x|yes|y|true|done|✓|✔)$/i.test(String(v).trim());
}

function clean_(t, max) {
  return String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim().slice(0, max || 120);
}

// Dates in the sheet come back as Date objects; anything else is passed through as short text.
function when_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v.toISOString();
  return clean_(v, 40);
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

function readQuestions_(sheet) {
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var text = clean_(values[i][0], 500);
    if (!text) continue;
    var answer = String(values[i][2] === null || values[i][2] === undefined ? '' : values[i][2]).trim().slice(0, 4000);
    out.push({ row: i + 1, text: text, asked: when_(values[i][1]), answer: answer, answered: when_(values[i][3]) });
  }
  return out;
}

// An exact (case-insensitive) match wins over a partial one, so "milk" never ticks "oat milk" by mistake.
function match_(tasks, phrase) {
  var m = clean_(phrase, 500).toLowerCase();
  if (!m) return null;
  var exact = tasks.filter(function (t) { return t.text.toLowerCase() === m; })[0];
  if (exact) return exact;
  return tasks.filter(function (t) { var x = t.text.toLowerCase(); return x.indexOf(m) >= 0 || m.indexOf(x) >= 0; })[0] || null;
}

function applyActions_(sheet, actions) {
  actions.forEach(function (a) {
    if (!a || typeof a !== 'object') return;
    if (a.op === 'duet_ask') {
      var question = clean_(a.text, 500);
      if (question) getQuestions_(true).appendRow([question, new Date(), '', '']);
      return;
    }
    if (a.op === 'duet_remove') {
      var qs = getQuestions_(false);
      var q = qs && readQuestions_(qs).filter(function (x) { return x.text.toLowerCase() === clean_(a.match, 500).toLowerCase(); })[0];
      if (q) qs.deleteRow(q.row);
      return;
    }
    var tasks = readTasks_(sheet);
    if (a.op === 'todo_add') {
      var texts = (Array.isArray(a.items) ? a.items : [a.text]).map(function (t) { return clean_(t); }).filter(Boolean);
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
        .sort(function (p, q2) { return q2 - p; })
        .forEach(function (row) { sheet.deleteRow(row); });
    }
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
