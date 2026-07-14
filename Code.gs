const DEFAULT_CONFIG = {
  spreadsheetId: '1ncJnbfJXqyWPDPKmtAMgC91Gg_p-_mjnsRO9r-3Jl-4',
  sheetName: '報告輪值表',
  lineChannelAccessToken: '',
  lineTargetId: '',
  reminderCount: 2,
};

const BOT_KEYS = {
  bindingPrefix: 'BINDING_',
  deferredPrefix: 'DEFERRED_',
  assignmentPrefix: 'ASSIGNMENT_',
  skippedPrefix: 'SKIPPED_',
};

function doGet() {
  return ContentService.createTextOutput('LINE report bot is running.');
}

function doPost(e) {
  try {
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (!expectedSecret || !e.parameter || e.parameter.key !== expectedSecret) {
      return ContentService.createTextOutput('Forbidden');
    }
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(handleLineEvent_);
  } catch (error) {
    console.error(error.stack || error);
  }
  return ContentService.createTextOutput('OK');
}

function handleLineEvent_(event) {
  if (!isAllowedSource_(event.source)) return;
  rememberLineTarget_(event.source);
  if (event.type === 'postback') {
    handlePostback_(event);
    return;
  }
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const bindingMatch = text.match(/^綁定\s+(.+)$/);
  if (bindingMatch) {
    bindMember_(event, bindingMatch[1].trim());
  } else if (/^(輪值|本週報告|下一位)$/.test(text)) {
    replyWithNextMeeting_(event.replyToken);
  } else if (text === '請假') {
    requestLeave_(event);
  } else if (text === '完成') {
    markMyReportComplete_(event);
  } else if (text === '我的ID') {
    replyText_(event.replyToken, event.source.userId || '無法取得 User ID');
  } else if (/^啟用輪值\s+(.+)$/.test(text)) {
    updateActiveReporter_(event, text.match(/^啟用輪值\s+(.+)$/)[1].trim(), true);
  } else if (/^停用輪值\s+(.+)$/.test(text)) {
    updateActiveReporter_(event, text.match(/^停用輪值\s+(.+)$/)[1].trim(), false);
  } else if (text === '輪值名單') {
    replyActiveReporters_(event);
  } else if (/^(說明|help|幫助)$/i.test(text)) {
    replyText_(event.replyToken, buildHelpText_());
  }
}

function sendDailyReminder() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
  const context = getSheetContext_();
  const tomorrow = addDays_(startOfDay_(new Date()), 1);
  if (!hasMeetingOn_(context.rows, tomorrow) || isMeetingSkipped_(tomorrow)) {
    Logger.log('Tomorrow has no active meeting.');
    return;
  }

  const sentKey = 'REMINDER_SENT_' + dateKey_(tomorrow);
  if (PropertiesService.getScriptProperties().getProperty(sentKey)) {
    Logger.log('Reminder already sent.');
    return;
  }

  const targets = getOrCreateAssignment_(context, tomorrow);
  if (targets.length === 0) {
    Logger.log('No active presenters found.');
    return;
  }
  pushMessages_(context.config, [buildReminderMessage_(tomorrow, targets)]);
  PropertiesService.getScriptProperties().setProperty(sentKey, new Date().toISOString());
  refreshAutoResults();
  } finally {
    lock.releaseLock();
  }
}

function sendWeeklyReminder() {
  const context = getSheetContext_();
  const meetingDate = findNextMeetingDate_(context.rows, startOfDay_(new Date()), true);
  if (!meetingDate) {
    Logger.log('No future meeting found.');
    return;
  }
  pushMessages_(context.config, [buildReminderMessage_(meetingDate, getOrCreateAssignment_(context, meetingDate))]);
  refreshAutoResults();
}

function refreshAutoResults() {
  const context = getSheetContext_();
  const nextMeeting = findNextMeetingDate_(context.rows, startOfDay_(new Date()), true);
  const nextTargets = nextMeeting ? getOrCreateAssignment_(context, nextMeeting) : [];
  const nextRows = new Set(nextTargets.map(function (row) { return row.rowNumber; }));

  context.rows.forEach(function (row) {
    const status = normalizeStatus_(row.status);
    let result = '等待中';
    if (isCompletedStatus_(status)) result = '已完成';
    else if (isLeaveStatus_(status)) result = '請假，下次補報告';
    else if (nextRows.has(row.rowNumber)) result = '下一個';
    context.sheet.getRange(row.rowNumber, context.layout.resultColumn).setValue(result);
  });
}

function bindMember_(event, requestedName) {
  const userId = event.source && event.source.userId;
  if (!userId) {
    replyText_(event.replyToken, 'LINE 沒有提供你的使用者 ID，請確認官方帳號已加入群組後再試一次。');
    return;
  }
  const context = getSheetContext_();
  const match = context.rows.find(function (row) {
    return row.reporter.toLowerCase() === requestedName.toLowerCase();
  });
  if (!match) {
    replyText_(event.replyToken, '名單中找不到「' + requestedName + '」，請輸入與 Sheet 完全相同的姓名。');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  const ownerKey = Object.keys(props.getProperties()).find(function (key) {
    return key.indexOf(BOT_KEYS.bindingPrefix) === 0 && key !== BOT_KEYS.bindingPrefix + userId &&
      props.getProperty(key) === match.reporter;
  });
  if (ownerKey) {
    replyText_(event.replyToken, '「' + match.reporter + '」已綁定其他 LINE 帳號，請聯絡管理員處理。');
    return;
  }
  props.setProperty(BOT_KEYS.bindingPrefix + userId, match.reporter);
  replyText_(event.replyToken, '綁定完成：' + match.reporter + '\n輪到你時可按「我要請假」或輸入「完成」。');
}

function updateActiveReporter_(event, requestedName, active) {
  if (!canSkipMeeting_(event.source.userId)) {
    replyText_(event.replyToken, '只有管理員可以修改輪值名單。');
    return;
  }
  const context = getSheetContext_();
  const canonicalName = getUniqueReporterNames_(context.rows).find(function (name) {
    return name.toLowerCase() === requestedName.toLowerCase();
  });
  if (!canonicalName) {
    replyText_(event.replyToken, 'Sheet 名單中找不到「' + requestedName + '」。');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('ACTIVE_REPORTERS');
  let names = stored ? JSON.parse(stored) : (active ? [] : getUniqueReporterNames_(context.rows));
  names = names.filter(function (name) { return name !== canonicalName; });
  if (active) names.push(canonicalName);
  props.setProperty('ACTIVE_REPORTERS', JSON.stringify(names));
  clearAssignmentCache_();
  replyText_(event.replyToken, canonicalName + (active ? ' 已加入輪值。' : ' 已暫停輪值。') + '\n目前名單：' + (names.join('、') || '無'));
  refreshAutoResults();
}

function replyActiveReporters_(event) {
  const context = getSheetContext_();
  const active = getActiveReporterNames_(context.rows);
  const mode = PropertiesService.getScriptProperties().getProperty('ACTIVE_REPORTERS') ? '指定名單' : 'Sheet 全部人員';
  replyText_(event.replyToken, '目前輪值（' + mode + '）：\n' + (active.join('、') || '無'));
}

function getUniqueReporterNames_(rows) {
  return Array.from(new Set(rows.map(function (row) { return row.reporter; })));
}

function getActiveReporterNames_(rows) {
  const stored = PropertiesService.getScriptProperties().getProperty('ACTIVE_REPORTERS');
  return stored ? JSON.parse(stored) : getUniqueReporterNames_(rows);
}

function clearAssignmentCache_() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(BOT_KEYS.assignmentPrefix) === 0) props.deleteProperty(key);
  });
}

function requestLeave_(event) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
  const member = getBoundMember_(event.source);
  if (!member) {
    replyText_(event.replyToken, '請先輸入「綁定 你的姓名」，例如：綁定 Julia_Liu');
    return;
  }

  const context = getSheetContext_();
  const meetingDate = findNextMeetingDate_(context.rows, startOfDay_(new Date()), true);
  if (!meetingDate) {
    replyText_(event.replyToken, '目前沒有即將到來的報告輪值。');
    return;
  }
  const targets = getOrCreateAssignment_(context, meetingDate);
  const myRow = targets.find(function (row) { return row.reporter === member; });
  if (!myRow) {
    replyText_(event.replyToken, member + ' 目前不在下一次報告名單中，無需請假。');
    return;
  }

  deferReporter_(context, myRow, meetingDate);
  const replacements = replaceAssignment_(context, meetingDate, myRow.rowNumber);
  const names = replacements.map(function (row) { return row.reporter; }).join('、') || '尚無替補人員';
  replyText_(event.replyToken, member + ' 已請假，將在下一個開會週優先補報告。\n更新後輪值：' + names);
  notifyGroup_(event.source, member + ' 本次請假，更新後報告人：' + names);
  refreshAutoResults();
  } finally {
    lock.releaseLock();
  }
}

function deferReporter_(context, row, currentMeeting) {
  const nextMeeting = findNextMeetingDate_(context.rows, addDays_(currentMeeting, 1), true);
  context.sheet.getRange(row.rowNumber, context.layout.statusColumn).setValue('請假');
  PropertiesService.getScriptProperties().setProperty(
    BOT_KEYS.deferredPrefix + row.rowNumber,
    String(nextMeeting ? nextMeeting.getTime() : addDays_(currentMeeting, 7).getTime())
  );
}

function markMyReportComplete_(event) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
  const member = getBoundMember_(event.source);
  if (!member) {
    replyText_(event.replyToken, '請先輸入「綁定 你的姓名」。');
    return;
  }
  const context = getSheetContext_();
  const meetingDate = findNextMeetingDate_(context.rows, startOfDay_(new Date()), true);
  const assigned = meetingDate ? getOrCreateAssignment_(context, meetingDate) : [];
  const candidate = assigned.find(function (row) { return row.reporter === member; });
  if (!candidate) {
    replyText_(event.replyToken, member + ' 沒有待完成的報告。');
    return;
  }
  context.sheet.getRange(candidate.rowNumber, context.layout.statusColumn).setValue('已報告');
  clearDeferred_(candidate.rowNumber);
  replaceAssignment_(context, meetingDate, candidate.rowNumber);
  replyText_(event.replyToken, member + ' 已標記為完成，謝謝！');
  refreshAutoResults();
  } finally {
    lock.releaseLock();
  }
}

function handlePostback_(event) {
  const data = parsePostback_(event.postback.data);
  if (data.action === 'leave') requestLeave_(event);
  else if (data.action === 'complete') markMyReportComplete_(event);
  else if (data.action === 'skip_prompt') {
    if (!canSkipMeeting_(event.source.userId)) {
      replyText_(event.replyToken, '只有管理員可以設定本週停會。');
      return;
    }
    replyMessages_(event.replyToken, [buildSkipConfirmation_(data.date)]);
  } else if (data.action === 'skip_confirm') {
    skipMeeting_(event, data.date);
  }
}

function skipMeeting_(event, dateKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
  if (!canSkipMeeting_(event.source.userId)) {
    replyText_(event.replyToken, '只有管理員可以設定本週停會。');
    return;
  }
  const meetingDate = parseDateKey_(dateKey);
  if (!meetingDate) {
    replyText_(event.replyToken, '無法辨識開會日期。');
    return;
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty(BOT_KEYS.skippedPrefix + dateKey, 'true');
  props.deleteProperty(BOT_KEYS.assignmentPrefix + dateKey);
  const text = formatDate_(meetingDate) + ' 已設為不開會，本週不會通知或消耗報告名單。';
  replyText_(event.replyToken, text);
  notifyGroup_(event.source, text);
  refreshAutoResults();
  } finally {
    lock.releaseLock();
  }
}

function replyWithNextMeeting_(replyToken) {
  const context = getSheetContext_();
  const meetingDate = findNextMeetingDate_(context.rows, startOfDay_(new Date()), true);
  if (!meetingDate) {
    replyText_(replyToken, '目前 Sheet 中沒有未來的開會日期。');
    return;
  }
  replyMessages_(replyToken, [buildReminderMessage_(meetingDate, getOrCreateAssignment_(context, meetingDate))]);
}

function getOrCreateAssignment_(context, meetingDate) {
  const props = PropertiesService.getScriptProperties();
  const key = BOT_KEYS.assignmentPrefix + dateKey_(meetingDate);
  const saved = props.getProperty(key);
  if (saved) return rowsFromNumbers_(context.rows, JSON.parse(saved));

  const targets = pickTargetsForMeeting_(context.rows, meetingDate, context.config.reminderCount);
  targets.forEach(function (row) {
    const deferredKey = BOT_KEYS.deferredPrefix + row.rowNumber;
    if (props.getProperty(deferredKey)) {
      context.sheet.getRange(row.rowNumber, context.layout.statusColumn).setValue('未報告');
      row.status = '未報告';
    }
  });
  props.setProperty(key, JSON.stringify(targets.map(function (row) { return row.rowNumber; })));
  return targets;
}

function replaceAssignment_(context, meetingDate, excludedRowNumber) {
  const props = PropertiesService.getScriptProperties();
  const key = BOT_KEYS.assignmentPrefix + dateKey_(meetingDate);
  const current = JSON.parse(props.getProperty(key) || '[]').filter(function (rowNumber) {
    return rowNumber !== excludedRowNumber;
  });
  const excluded = new Set(current.concat([excludedRowNumber]));
  const candidates = pickTargetsForMeeting_(context.rows, meetingDate, context.rows.length)
    .filter(function (row) { return !excluded.has(row.rowNumber); });
  while (current.length < context.config.reminderCount && candidates.length) current.push(candidates.shift().rowNumber);
  rowsFromNumbers_(context.rows, current).forEach(function (row) {
    if (props.getProperty(BOT_KEYS.deferredPrefix + row.rowNumber)) {
      context.sheet.getRange(row.rowNumber, context.layout.statusColumn).setValue('未報告');
      row.status = '未報告';
    }
  });
  props.setProperty(key, JSON.stringify(current));
  return rowsFromNumbers_(context.rows, current);
}

function rowsFromNumbers_(rows, rowNumbers) {
  return rowNumbers.map(function (rowNumber) {
    return rows.find(function (row) { return row.rowNumber === rowNumber; });
  }).filter(Boolean);
}

function pickTargetsForMeeting_(rows, meetingDate, count) {
  const props = PropertiesService.getScriptProperties();
  const activeNames = new Set(getActiveReporterNames_(rows));
  const deferred = [];
  const regular = [];
  rows.forEach(function (row) {
    if (!activeNames.has(row.reporter)) return;
    const status = normalizeStatus_(row.status);
    if (isCompletedStatus_(status)) return;
    const deferredAt = Number(props.getProperty(BOT_KEYS.deferredPrefix + row.rowNumber) || 0);
    if (deferredAt && deferredAt <= meetingDate.getTime()) deferred.push(row);
    else if (!isLeaveStatus_(status)) regular.push(row);
  });
  return deferred.concat(regular).slice(0, count);
}

function buildReminderMessage_(meetingDate, targets) {
  const names = targets.length ? targets.map(function (row, index) {
    return (index + 1) + '. ' + row.reporter + (row.topic ? '｜' + row.topic : '');
  }).join('\n') : '目前沒有可排入的人員';
  const text = ('📣 報告提醒\n開會日期：' + formatDate_(meetingDate) + '\n本次報告：\n' + names +
      '\n\n報告人可按「我要請假」；管理員可設定本週不開會。').slice(0, 5000);
  return {
    type: 'text',
    text: text,
    quickReply: {
      items: [
        quickPostback_('🙋 我要請假', 'action=leave'),
        quickPostback_('✅ 完成報告', 'action=complete'),
        quickPostback_('⏭️ 本週不開會', 'action=skip_prompt&date=' + dateKey_(meetingDate)),
      ],
    },
  };
}

function buildSkipConfirmation_(dateKey) {
  return {
    type: 'template',
    altText: '確認本週不開會',
    template: {
      type: 'confirm',
      text: '確定要將 ' + dateKey + ' 設為不開會嗎？名單會保留到下一週。',
      actions: [
        { type: 'postback', label: '確定 SKIP', data: 'action=skip_confirm&date=' + dateKey, displayText: '確定本週不開會' },
        { type: 'message', label: '取消', text: '取消 SKIP' },
      ],
    },
  };
}

function quickPostback_(label, data) {
  return { type: 'action', action: { type: 'postback', label: label, data: data, displayText: label } };
}

function getSheetContext_() {
  const config = getConfig_();
  const sheet = getSheet_(config);
  const layout = detectLayout_(sheet);
  return { config: config, sheet: sheet, layout: layout, rows: readRows_(sheet, layout) };
}

function detectLayout_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  for (let i = 0; i < Math.min(values.length, 30); i++) {
    const normalized = values[i].map(normalizeStatus_);
    const reporterColumn = normalized.indexOf('報告人') + 1;
    const statusColumn = normalized.indexOf('狀態') + 1;
    if (reporterColumn && statusColumn) {
      const layout = {
        headerRow: i + 1,
        reportDateColumn: normalized.indexOf('報告日期') + 1,
        reporterColumn: reporterColumn,
        topicColumn: normalized.indexOf('報告主題') + 1,
        statusColumn: statusColumn,
        resultColumn: normalized.findIndex(function (value) { return value.indexOf('結果') === 0; }) + 1,
      };
      if (layout.reportDateColumn && layout.topicColumn && layout.resultColumn) return layout;
    }
  }
  throw new Error('找不到表頭，請確認欄位包含「報告日期、報告人、報告主題、狀態、結果」。');
}

function readRows_(sheet, layout) {
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = layout.headerRow; i < values.length; i++) {
    const row = values[i];
    const reporter = String(row[layout.reporterColumn - 1] || '').trim();
    if (!reporter) continue;
    rows.push({
      rowNumber: i + 1,
      reportDate: parseSheetDate_(row[layout.reportDateColumn - 1]),
      reporter: reporter,
      topic: String(row[layout.topicColumn - 1] || '').trim(),
      status: String(row[layout.statusColumn - 1] || '').trim(),
    });
  }
  return rows;
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    spreadsheetId: props.getProperty('SPREADSHEET_ID') || DEFAULT_CONFIG.spreadsheetId,
    sheetName: props.getProperty('SHEET_NAME') || DEFAULT_CONFIG.sheetName,
    lineChannelAccessToken: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '',
    lineTargetId: props.getProperty('LINE_TARGET_ID') || '',
    reminderCount: Number(props.getProperty('REMINDER_COUNT') || DEFAULT_CONFIG.reminderCount),
  };
}

function getSheet_(config) {
  const spreadsheet = config.spreadsheetId ? SpreadsheetApp.openById(config.spreadsheetId) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName(config.sheetName);
  if (!sheet) throw new Error('找不到工作表：' + config.sheetName);
  return sheet;
}

function findNextMeetingDate_(rows, fromDate, includeFromDate) {
  const from = startOfDay_(fromDate).getTime();
  const dates = rows.map(function (row) { return row.reportDate; }).filter(Boolean)
    .filter(function (date) { return includeFromDate ? date.getTime() >= from : date.getTime() > from; })
    .filter(function (date) { return !isMeetingSkipped_(date); })
    .sort(function (a, b) { return a.getTime() - b.getTime(); });
  return dates.length ? dates[0] : null;
}

function hasMeetingOn_(rows, date) {
  return rows.some(function (row) { return row.reportDate && row.reportDate.getTime() === startOfDay_(date).getTime(); });
}

function parseSheetDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return startOfDay_(value);
  const match = String(value || '').match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day ? parsed : null;
}

function canSkipMeeting_(userId) {
  const ids = (PropertiesService.getScriptProperties().getProperty('LINE_ADMIN_USER_IDS') || '')
    .split(',').map(function (id) { return id.trim(); }).filter(Boolean);
  return ids.length === 0 || ids.indexOf(userId) !== -1;
}

function getBoundMember_(source) {
  return source && source.userId ? PropertiesService.getScriptProperties().getProperty(BOT_KEYS.bindingPrefix + source.userId) : null;
}

function rememberLineTarget_(source) {
  const targetId = source && (source.groupId || source.roomId);
  const props = PropertiesService.getScriptProperties();
  if (targetId && !props.getProperty('LINE_TARGET_ID')) props.setProperty('LINE_TARGET_ID', targetId);
}

function isAllowedSource_(source) {
  const configured = PropertiesService.getScriptProperties().getProperty('LINE_TARGET_ID');
  const incoming = source && (source.groupId || source.roomId);
  return !configured || !incoming || configured === incoming;
}

function notifyGroup_(source, text) {
  const targetId = source && (source.groupId || source.roomId);
  if (targetId) pushMessages_(Object.assign(getConfig_(), { lineTargetId: targetId }), [{ type: 'text', text: text }]);
}

function replyText_(replyToken, text) {
  replyMessages_(replyToken, [{ type: 'text', text: text }]);
}

function replyMessages_(replyToken, messages) {
  callLineApi_('/v2/bot/message/reply', { replyToken: replyToken, messages: messages });
}

function pushMessages_(config, messages) {
  if (!config.lineTargetId) throw new Error('尚未取得群組 ID；請先把 Bot 加入群組並在群組輸入「說明」。');
  callLineApi_('/v2/bot/message/push', { to: config.lineTargetId, messages: messages }, config);
}

function callLineApi_(path, payload, optionalConfig) {
  const config = optionalConfig || getConfig_();
  if (!config.lineChannelAccessToken) throw new Error('請先設定 LINE_CHANNEL_ACCESS_TOKEN。');
  const response = UrlFetchApp.fetch('https://api.line.me' + path, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + config.lineChannelAccessToken },
    payload: JSON.stringify(payload),
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('LINE API 失敗：' + response.getResponseCode() + ' ' + response.getContentText());
  }
}

function parsePostback_(value) {
  return String(value || '').split('&').reduce(function (result, part) {
    const pair = part.split('=');
    result[decodeURIComponent(pair[0])] = decodeURIComponent(pair.slice(1).join('=') || '');
    return result;
  }, {});
}

function clearDeferred_(rowNumber) {
  PropertiesService.getScriptProperties().deleteProperty(BOT_KEYS.deferredPrefix + rowNumber);
}

function isMeetingSkipped_(date) {
  return PropertiesService.getScriptProperties().getProperty(BOT_KEYS.skippedPrefix + dateKey_(date)) === 'true';
}

function parseDateKey_(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function dateKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays_(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return startOfDay_(result);
}

function normalizeStatus_(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function isCompletedStatus_(status) {
  return ['已報告', '已完成', '完成', '已交', 'done'].indexOf(status) !== -1;
}

function isLeaveStatus_(status) {
  return ['請假', '休假', '補報告', '延期'].indexOf(status) !== -1;
}

function buildHelpText_() {
  return [
    '📖 報告輪值 Bot 指令',
    '「綁定 姓名」：綁定 Sheet 裡的姓名',
    '「輪值」：查看下一次報告人',
    '「請假」：輪到自己時順延到下個開會週',
    '「完成」：將自己的報告標記完成',
    '「我的ID」：取得管理員設定需要的 User ID',
    '管理員「啟用輪值 姓名」：加入指定人員',
    '管理員「停用輪值 姓名」：暫停指定人員',
    '「輪值名單」：查看目前參與人員',
    '每天自動檢查，並在開會前一天提醒。',
  ].join('\n');
}
