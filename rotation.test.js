const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const store = {};
const scriptProperties = {
  getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null,
  setProperty: (key, value) => { store[key] = String(value); },
  deleteProperty: (key) => { delete store[key]; },
  getProperties: () => ({ ...store }),
};
const context = {
  console,
  PropertiesService: { getScriptProperties: () => scriptProperties },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Session: { getScriptTimeZone: () => 'Asia/Taipei' },
  Utilities: { formatDate: (date, _zone, format) => {
    const p = (n) => String(n).padStart(2, '0');
    if (format === 'yyyy-MM-dd') return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    if (format === 'yyyy/MM/dd') return `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())}`;
    return `${date.getFullYear()}/${p(date.getMonth() + 1)}/${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
  }},
  UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }) },
  ContentService: { createTextOutput: (text) => text },
  Logger: { log() {} },
  Set,
  Date,
  JSON,
  Math,
  Number,
  String,
  Object,
  Array,
  RegExp,
  Boolean,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), context);

context.setJson_('ROSTER', [
  { userId: 'A', name: 'A' },
  { userId: 'B', name: 'B' },
  { userId: 'C', name: 'C' },
  { userId: 'D', name: 'D' },
]);
context.setJson_('ROTATION_QUEUE', ['A', 'B', 'C', 'D']);
const meeting1 = new Date(2026, 6, 21, 10, 0);
const meeting2 = new Date(2026, 6, 28, 10, 0);
assert.deepStrictEqual(Array.from(context.getOrCreateAssignment_(meeting1)), ['A', 'B']);
context.setJson_('DEFERRED_REPORTERS', [{ userId: 'A', after: meeting1.getTime() }]);
assert.deepStrictEqual(Array.from(context.getOrderedCandidates_(meeting1)), ['B', 'C', 'D']);
assert.deepStrictEqual(Array.from(context.getOrderedCandidates_(meeting2)), ['A', 'B', 'C', 'D']);
context.rotateToEnd_('B');
assert.deepStrictEqual(Array.from(context.getQueue_()), ['A', 'C', 'D', 'B']);
context.setProperty_('REMINDER_COUNT', 'not-a-number');
assert.strictEqual(context.reminderCount_(), 2);
context.setJson_('DEFERRED_REPORTERS', []);
context.setJson_('ROTATION_QUEUE', ['A', 'B', 'C', 'D']);
context.setProperty_('REMINDER_COUNT', '1');
const meeting3 = new Date(2026, 7, 4, 10, 0);
assert.deepStrictEqual(Array.from(context.getOrCreateAssignment_(meeting3)), ['A']);
console.log('Rotation logic tests: OK');
