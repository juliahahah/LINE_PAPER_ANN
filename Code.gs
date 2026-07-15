const KEYS = {
  roster: 'ROSTER',
  queue: 'ROTATION_QUEUE',
  deferred: 'DEFERRED_REPORTERS',
  weeklyMeeting: 'WEEKLY_MEETING',
  nextMeeting: 'NEXT_MEETING',
  groupId: 'LINE_TARGET_ID',
  admins: 'LINE_ADMIN_USER_IDS',
  token: 'LINE_CHANNEL_ACCESS_TOKEN',
  webhookSecret: 'WEBHOOK_SECRET',
  assignmentPrefix: 'ASSIGNMENT_',
  skippedPrefix: 'SKIPPED_',
  sentPrefix: 'REMINDER_SENT_',
};

const WEEKDAYS = {
  '星期日': 0, '週日': 0, '星期天': 0, '週天': 0,
  '星期一': 1, '週一': 1,
  '星期二': 2, '週二': 2,
  '星期三': 3, '週三': 3,
  '星期四': 4, '週四': 4,
  '星期五': 5, '週五': 5,
  '星期六': 6, '週六': 6,
};

function doGet() {
  return ContentService.createTextOutput('LINE rotation bot is running.');
}

function doPost(e) {
  try {
    const expected = getProperty_(KEYS.webhookSecret);
    if (expected && (!e.parameter || e.parameter.key !== expected)) {
      return ContentService.createTextOutput('Forbidden');
    }
    const body = JSON.parse(e.postData.contents);
    (body.events || []).forEach(function (event) {
      try {
        handleEvent_(event);
      } catch (eventError) {
        console.error(eventError.stack || eventError);
      }
    });
  } catch (error) {
    console.error(error.stack || error);
  }
  return ContentService.createTextOutput('OK');
}

function handleEvent_(event) {
  if (!isAllowedGroup_(event.source)) return;
  rememberGroup_(event.source);

  if (event.type === 'postback') {
    handlePostback_(event);
    return;
  }
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  if (text === '初始化管理員') initializeAdmin_(event);
  else if (text === '我的ID') replyText_(event.replyToken, event.source.userId || '無法取得 User ID');
  else if (/^加入輪值/.test(text)) addMentionedMembers_(event);
  else if (/^移除輪值/.test(text)) removeMentionedMembers_(event);
  else if (text === '加入我輪值') addSelf_(event);
  else if (text === '輪值名單') replyRoster_(event);
  else if (/^設定週會\s+/.test(text)) setWeeklyMeeting_(event, text);
  else if (/^設定下次會議\s+/.test(text)) setNextMeeting_(event, text);
  else if (/^(輪值|本週報告|下一位)$/.test(text)) replyCurrentRotation_(event.replyToken);
  else if (text === '請假') requestLeave_(event);
  else if (/^幫請假/.test(text)) requestLeaveForMentionedMember_(event);
  else if (text === '完成') completeReport_(event);
  else if (/^(說明|help|幫助)$/i.test(text)) replyText_(event.replyToken, helpText_());
}

function initializeAdmin_(event) {
  withLock_(function () {
  const admins = getAdminIds_();
  if (admins.length) {
    replyText_(event.replyToken, '管理員已設定，無法再次初始化。');
    return;
  }
  if (!event.source.userId) {
    replyText_(event.replyToken, '無法取得你的 LINE User ID。');
    return;
  }
  setProperty_(KEYS.admins, event.source.userId);
  replyText_(event.replyToken, '初始化完成，你已成為 Bot 管理員。');
  });
}

function addMentionedMembers_(event) {
  if (!requireAdmin_(event)) return;
  withLock_(function () {
  const mentionees = getMentionedUsers_(event.message);
  if (!mentionees.length) {
    replyText_(event.replyToken, '請輸入「加入輪值」並標註要加入的群組成員。');
    return;
  }
  const roster = getRoster_();
  const queue = getQueue_();
  const added = [];
  mentionees.forEach(function (mentionee) {
    if (roster.some(function (member) { return member.userId === mentionee.userId; })) return;
    const name = getMemberName_(event.source, mentionee.userId, mentionee.fallbackName);
    roster.push({ userId: mentionee.userId, name: name });
    queue.push(mentionee.userId);
    added.push(name);
  });
  saveRosterAndQueue_(roster, queue);
  clearFutureAssignments_();
  replyText_(event.replyToken, added.length ? '已加入輪值：' + added.join('、') : '這些成員已在輪值名單中。');
  });
}

function addSelf_(event) {
  withLock_(function () {
  if (!event.source.userId) {
    replyText_(event.replyToken, '無法取得你的 LINE User ID。');
    return;
  }
  const roster = getRoster_();
  if (roster.some(function (member) { return member.userId === event.source.userId; })) {
    replyText_(event.replyToken, '你已在輪值名單中。');
    return;
  }
  const name = getMemberName_(event.source, event.source.userId, 'LINE 成員');
  const queue = getQueue_();
  roster.push({ userId: event.source.userId, name: name });
  queue.push(event.source.userId);
  saveRosterAndQueue_(roster, queue);
  clearFutureAssignments_();
  replyText_(event.replyToken, name + ' 已加入輪值。');
  });
}

function removeMentionedMembers_(event) {
  if (!requireAdmin_(event)) return;
  withLock_(function () {
  const mentionees = getMentionedUsers_(event.message);
  if (!mentionees.length) {
    replyText_(event.replyToken, '請輸入「移除輪值」並標註要移除的成員。');
    return;
  }
  const ids = new Set(mentionees.map(function (item) { return item.userId; }));
  const roster = getRoster_();
  const removed = roster.filter(function (member) { return ids.has(member.userId); });
  const newRoster = roster.filter(function (member) { return !ids.has(member.userId); });
  const newQueue = getQueue_().filter(function (id) { return !ids.has(id); });
  const deferred = getDeferred_().filter(function (item) { return !ids.has(item.userId); });
  saveRosterAndQueue_(newRoster, newQueue);
  setJson_(KEYS.deferred, deferred);
  clearFutureAssignments_();
  replyText_(event.replyToken, removed.length ? '已移除：' + removed.map(function (member) { return member.name; }).join('、') : '指定成員不在輪值名單中。');
  });
}

function replyRoster_(event) {
  const roster = getRoster_();
  const queue = getOrderedCandidates_(new Date(8640000000000000));
  if (!roster.length) {
    replyText_(event.replyToken, '目前沒有輪值成員。管理員可輸入「加入輪值」並標註成員。');
    return;
  }
  const names = queue.map(function (id, index) {
    return (index + 1) + '. ' + memberName_(id, roster);
  });
  replyText_(event.replyToken, '目前輪值順序：\n' + names.join('\n'));
}

function setWeeklyMeeting_(event, text) {
  if (!requireAdmin_(event)) return;
  withLock_(function () {
  const match = text.match(/^設定週會\s+(星期[一二三四五六日天]|週[一二三四五六日天])\s+(\d{1,2}):(\d{2})$/);
  if (!match || WEEKDAYS[match[1]] === undefined || !validTime_(Number(match[2]), Number(match[3]))) {
    replyText_(event.replyToken, '格式：設定週會 星期二 10:00');
    return;
  }
  const config = { weekday: WEEKDAYS[match[1]], hour: Number(match[2]), minute: Number(match[3]), label: match[1] };
  setJson_(KEYS.weeklyMeeting, config);
  clearFutureAssignments_();
  replyText_(event.replyToken, '已設定每週 ' + match[1] + ' ' + pad_(config.hour) + ':' + pad_(config.minute) + ' 開會。');
  });
}

function setNextMeeting_(event, text) {
  if (!requireAdmin_(event)) return;
  withLock_(function () {
  const match = text.match(/^設定下次會議\s+(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    replyText_(event.replyToken, '格式：設定下次會議 2026/07/21 10:00');
    return;
  }
  const date = makeDate_(Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  if (!date || date.getTime() <= Date.now()) {
    replyText_(event.replyToken, '日期時間無效，或會議時間已經過去。');
    return;
  }
  setProperty_(KEYS.nextMeeting, String(date.getTime()));
  clearFutureAssignments_();
  replyText_(event.replyToken, '下次會議已設定為 ' + formatDateTime_(date) + '。');
  });
}

function sendDailyReminder() {
  sendReminder_(false);
}

function sendTestReminder() {
  sendReminder_(true);
}

function sendReminder_(repeatForTesting) {
  withLock_(function () {
    const meeting = findNextMeeting_(new Date());
    if (!meeting) return;
    const tomorrow = addDays_(startOfDay_(new Date()), 1);
    if (startOfDay_(meeting).getTime() !== tomorrow.getTime()) return;
    const sentKey = KEYS.sentPrefix + meetingKey_(meeting);
    if (!repeatForTesting && getProperty_(sentKey)) return;
    const assignment = getOrCreateAssignment_(meeting);
    if (!assignment.length) return;
    pushMessages_([buildRotationMessage_(meeting, assignment, true)]);
    if (!repeatForTesting) setProperty_(sentKey, new Date().toISOString());
  });
}

function replyCurrentRotation_(replyToken) {
  const meeting = findNextMeeting_(new Date());
  if (!meeting) {
    replyText_(replyToken, '尚未設定會議。管理員請輸入「設定週會 星期二 10:00」。');
    return;
  }
  replyMessages_(replyToken, [buildRotationMessage_(meeting, getOrCreateAssignment_(meeting), false)]);
}

function requestLeave_(event) {
  requestLeaveForUser_(event, event.source.userId);
}

function requestLeaveForMentionedMember_(event) {
  if (!requireAdmin_(event)) return;
  const mentionees = getMentionedUsers_(event.message);
  if (mentionees.length !== 1) {
    replyText_(event.replyToken, '請輸入「幫請假」並標註一位本次報告人。');
    return;
  }
  requestLeaveForUser_(event, mentionees[0].userId);
}

function requestLeaveForUser_(event, userId) {
  withLock_(function () {
    const meeting = findNextMeeting_(new Date());
    if (!meeting) {
      replyText_(event.replyToken, '目前沒有即將到來的會議。');
      return;
    }
    const assignment = getOrCreateAssignment_(meeting);
    if (assignment.indexOf(userId) === -1) {
      replyText_(event.replyToken, '你目前不在下一次報告名單中，無需請假。');
      return;
    }
    const deferred = getDeferred_().filter(function (item) { return item.userId !== userId; });
    deferred.push({ userId: userId, after: meeting.getTime() });
    setJson_(KEYS.deferred, deferred);
    const updated = assignment.filter(function (id) { return id !== userId; });
    const candidates = getOrderedCandidates_(meeting).filter(function (id) {
      return updated.indexOf(id) === -1 && id !== userId;
    });
    if (candidates.length) updated.push(candidates[0]);
    setAssignment_(meeting, updated);
    const name = memberName_(userId);
    replyText_(event.replyToken, name + ' 已請假，下一個開會週會優先補報告。');
    pushMessages_([buildRotationMessage_(meeting, updated, false)]);
  });
}

function completeReport_(event) {
  withLock_(function () {
    const userId = event.source.userId;
    const meeting = findActionableMeetingForUser_(userId);
    if (!meeting) {
      replyText_(event.replyToken, '目前沒有進行中的報告輪值。');
      return;
    }
    const assignment = getOrCreateAssignment_(meeting);
    if (assignment.indexOf(userId) === -1) {
      replyText_(event.replyToken, '你不在這次報告名單中。');
      return;
    }
    rotateToEnd_(userId);
    const deferred = getDeferred_().filter(function (item) { return item.userId !== userId; });
    setJson_(KEYS.deferred, deferred);
    setAssignment_(meeting, assignment.filter(function (id) { return id !== userId; }));
    replyText_(event.replyToken, memberName_(userId) + ' 已完成報告並排到輪值尾端。');
  });
}

function handlePostback_(event) {
  const data = parseQuery_(event.postback.data);
  if (data.action === 'leave') requestLeave_(event);
  else if (data.action === 'complete') completeReport_(event);
  else if (data.action === 'skip_prompt') {
    if (!requireAdmin_(event)) return;
    replyMessages_(event.replyToken, [skipConfirmation_(data.date)]);
  } else if (data.action === 'skip_confirm') skipMeeting_(event, data.date);
}

function skipMeeting_(event, dateValue) {
  if (!requireAdmin_(event)) return;
  withLock_(function () {
    const date = parseDateKey_(dateValue);
    if (!date) {
      replyText_(event.replyToken, '無法辨識會議日期。');
      return;
    }
    setProperty_(KEYS.skippedPrefix + dateValue, 'true');
    deleteMeetingStateForDate_(date);
    if (Number(getProperty_(KEYS.nextMeeting)) && dateKey_(new Date(Number(getProperty_(KEYS.nextMeeting)))) === dateValue) {
      deleteProperty_(KEYS.nextMeeting);
    }
    replyText_(event.replyToken, formatDate_(date) + ' 已設定為不開會，輪值順序保持不變。');
  });
}

function getOrCreateAssignment_(meeting) {
  const key = KEYS.assignmentPrefix + meetingKey_(meeting);
  const saved = getJson_(key, null);
  if (saved) return saved.filter(isActiveMember_);
  const assignment = getOrderedCandidates_(meeting).slice(0, reminderCount_());
  setJson_(key, assignment);
  return assignment;
}

function setAssignment_(meeting, assignment) {
  setJson_(KEYS.assignmentPrefix + meetingKey_(meeting), assignment);
}

function getOrderedCandidates_(meeting) {
  const activeIds = new Set(getRoster_().map(function (member) { return member.userId; }));
  const allDeferred = getDeferred_().filter(function (item) { return activeIds.has(item.userId); });
  const eligibleDeferred = allDeferred.filter(function (item) { return item.after < meeting.getTime(); })
    .map(function (item) { return item.userId; });
  const deferredIds = new Set(allDeferred.map(function (item) { return item.userId; }));
  const queue = getQueue_().filter(function (id) { return activeIds.has(id) && !deferredIds.has(id); });
  return eligibleDeferred.concat(queue);
}

function rotateToEnd_(userId) {
  const queue = getQueue_().filter(function (id) { return id !== userId; });
  if (isActiveMember_(userId)) queue.push(userId);
  setJson_(KEYS.queue, queue);
}

function findNextMeeting_(from) {
  const oneOff = Number(getProperty_(KEYS.nextMeeting) || 0);
  const candidates = [];
  if (oneOff > from.getTime()) candidates.push(new Date(oneOff));

  const weekly = getJson_(KEYS.weeklyMeeting, null);
  if (weekly) {
    for (let offset = 0; offset <= 366; offset++) {
      const day = addDays_(startOfDay_(from), offset);
      if (day.getDay() !== weekly.weekday) continue;
      const meeting = new Date(day.getFullYear(), day.getMonth(), day.getDate(), weekly.hour, weekly.minute);
      if (meeting.getTime() > from.getTime() && !isSkipped_(meeting)) {
        candidates.push(meeting);
        break;
      }
    }
  }
  return candidates.filter(function (date) { return !isSkipped_(date); })
    .sort(function (a, b) { return a.getTime() - b.getTime(); })[0] || null;
}

function buildRotationMessage_(meeting, userIds, isReminder) {
  const roster = getRoster_();
  let text = isReminder ? '📣 明天報告提醒\n' : '📋 下一次報告輪值\n';
  text += '會議：' + formatDateTime_(meeting) + '\n報告人：';
  const mentionees = [];
  if (!userIds.length) text += '\n尚無輪值成員';
  userIds.forEach(function (userId, index) {
    const token = '@' + memberName_(userId, roster);
    text += '\n' + (index + 1) + '. ';
    const mentionIndex = text.length;
    text += token;
    mentionees.push({ index: mentionIndex, length: token.length, userId: userId });
  });
  const message = {
    type: 'text',
    text: text.slice(0, 5000),
    quickReply: {
      items: [
        quickPostback_('🙋 我要請假', 'action=leave'),
        quickPostback_('✅ 完成報告', 'action=complete'),
        quickPostback_('⏭️ 本週不開會', 'action=skip_prompt&date=' + dateKey_(meeting)),
      ],
    },
  };
  if (mentionees.length) message.mention = { mentionees: mentionees };
  return message;
}

function skipConfirmation_(date) {
  return {
    type: 'template',
    altText: '確認本週不開會',
    template: {
      type: 'confirm',
      text: '確定將 ' + date + ' 設為不開會嗎？輪值順序會保留。',
      actions: [
        { type: 'postback', label: '確定 SKIP', data: 'action=skip_confirm&date=' + date, displayText: '確定本週不開會' },
        { type: 'message', label: '取消', text: '取消 SKIP' },
      ],
    },
  };
}

function getMentionedUsers_(message) {
  const mentionees = message.mention && message.mention.mentionees || [];
  return mentionees.filter(function (item) { return item.type === 'user' && item.userId; }).map(function (item) {
    const raw = message.text.substring(item.index, item.index + item.length).replace(/^@/, '');
    return { userId: item.userId, fallbackName: raw || 'LINE 成員' };
  });
}

function getMemberName_(source, userId, fallback) {
  try {
    let path;
    if (source.groupId) path = '/v2/bot/group/' + encodeURIComponent(source.groupId) + '/member/' + encodeURIComponent(userId);
    else if (source.roomId) path = '/v2/bot/room/' + encodeURIComponent(source.roomId) + '/member/' + encodeURIComponent(userId);
    else path = '/v2/bot/profile/' + encodeURIComponent(userId);
    const response = lineRequest_(path, 'get');
    return JSON.parse(response.getContentText()).displayName || fallback;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function getRoster_() {
  return getJson_(KEYS.roster, []);
}

function getQueue_() {
  return getJson_(KEYS.queue, []);
}

function getDeferred_() {
  return getJson_(KEYS.deferred, []).map(function (item) {
    return typeof item === 'string' ? { userId: item, after: 0 } : item;
  }).filter(function (item) { return item && item.userId; });
}

function saveRosterAndQueue_(roster, queue) {
  setJson_(KEYS.roster, roster);
  setJson_(KEYS.queue, Array.from(new Set(queue)));
}

function memberName_(userId, optionalRoster) {
  const member = (optionalRoster || getRoster_()).find(function (item) { return item.userId === userId; });
  return member ? member.name : '未知成員';
}

function isActiveMember_(userId) {
  return getRoster_().some(function (member) { return member.userId === userId; });
}

function clearFutureAssignments_() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(KEYS.assignmentPrefix) === 0 || key.indexOf(KEYS.sentPrefix) === 0) props.deleteProperty(key);
  });
}

function rememberGroup_(source) {
  const incoming = source && (source.groupId || source.roomId);
  if (incoming && !getProperty_(KEYS.groupId)) setProperty_(KEYS.groupId, incoming);
}

function isAllowedGroup_(source) {
  const configured = getProperty_(KEYS.groupId);
  const incoming = source && (source.groupId || source.roomId);
  return Boolean(incoming) && (!configured || configured === incoming);
}

function requireAdmin_(event) {
  if (getAdminIds_().indexOf(event.source.userId) !== -1) return true;
  replyText_(event.replyToken, '只有管理員可以執行這個操作。');
  return false;
}

function getAdminIds_() {
  return String(getProperty_(KEYS.admins) || '').split(',').map(function (id) { return id.trim(); }).filter(Boolean);
}

function reminderCount_() {
  const value = Number(getProperty_('REMINDER_COUNT') || 2);
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.floor(value), 10)) : 2;
}

function findActionableMeetingForUser_(userId) {
  const now = Date.now();
  const lowerBound = now - 7 * 24 * 60 * 60 * 1000;
  const matches = [];
  const properties = PropertiesService.getScriptProperties().getProperties();
  Object.keys(properties).forEach(function (key) {
    if (key.indexOf(KEYS.assignmentPrefix) !== 0) return;
    const timestamp = Number(key.substring(KEYS.assignmentPrefix.length));
    if (!Number.isFinite(timestamp) || timestamp < lowerBound) return;
    const assignment = getJson_(key, []);
    if (assignment.indexOf(userId) !== -1 && !isSkipped_(new Date(timestamp))) matches.push(timestamp);
  });
  const past = matches.filter(function (timestamp) { return timestamp <= now; }).sort(function (a, b) { return b - a; });
  const future = matches.filter(function (timestamp) { return timestamp > now; }).sort(function (a, b) { return a - b; });
  if (past.length) return new Date(past[0]);
  if (future.length) return new Date(future[0]);
  const next = findNextMeeting_(new Date());
  if (!next) return null;
  return getOrCreateAssignment_(next).indexOf(userId) !== -1 ? next : null;
}

function deleteMeetingStateForDate_(date) {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (key) {
    if (key.indexOf(KEYS.assignmentPrefix) !== 0 && key.indexOf(KEYS.sentPrefix) !== 0) return;
    const prefix = key.indexOf(KEYS.assignmentPrefix) === 0 ? KEYS.assignmentPrefix : KEYS.sentPrefix;
    const timestamp = Number(key.substring(prefix.length));
    if (Number.isFinite(timestamp) && dateKey_(new Date(timestamp)) === dateKey_(date)) props.deleteProperty(key);
  });
}

function pushMessages_(messages) {
  const target = getProperty_(KEYS.groupId);
  if (!target) throw new Error('尚未取得 LINE 群組 ID。');
  lineRequest_('/v2/bot/message/push', 'post', { to: target, messages: messages });
}

function replyText_(replyToken, text) {
  replyMessages_(replyToken, [{ type: 'text', text: text.slice(0, 5000) }]);
}

function replyMessages_(replyToken, messages) {
  lineRequest_('/v2/bot/message/reply', 'post', { replyToken: replyToken, messages: messages });
}

function lineRequest_(path, method, payload) {
  const token = getProperty_(KEYS.token);
  if (!token) throw new Error('請設定 LINE_CHANNEL_ACCESS_TOKEN。');
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
  };
  if (payload) {
    options.contentType = 'application/json; charset=UTF-8';
    options.payload = JSON.stringify(payload);
  }
  const response = UrlFetchApp.fetch('https://api.line.me' + path, options);
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('LINE API 失敗：' + response.getResponseCode() + ' ' + response.getContentText());
  }
  return response;
}

function quickPostback_(label, data) {
  return { type: 'action', action: { type: 'postback', label: label, data: data, displayText: label } };
}

function parseQuery_(value) {
  return String(value || '').split('&').reduce(function (result, part) {
    const pair = part.split('=');
    result[decodeURIComponent(pair[0])] = decodeURIComponent(pair.slice(1).join('=') || '');
    return result;
  }, {});
}

function isSkipped_(date) {
  return getProperty_(KEYS.skippedPrefix + dateKey_(date)) === 'true';
}

function parseDateKey_(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? makeDate_(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0) : null;
}

function makeDate_(year, month, day, hour, minute) {
  if (!validTime_(hour, minute)) return null;
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function validTime_(hour, minute) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays_(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return startOfDay_(result);
}

function dateKey_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function meetingKey_(date) {
  return String(date.getTime());
}

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

function formatDateTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

function pad_(value) {
  return String(value).padStart(2, '0');
}

function getProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

function deleteProperty_(key) {
  PropertiesService.getScriptProperties().deleteProperty(key);
}

function getJson_(key, fallback) {
  const value = getProperty_(key);
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error('Invalid JSON in ' + key);
    return fallback;
  }
}

function setJson_(key, value) {
  setProperty_(key, JSON.stringify(value));
}

function withLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function helpText_() {
  return [
    '📖 PAPER CALL 指令',
    '管理員：加入輪值 + 標註成員',
    '管理員：移除輪值 + 標註成員',
    '加入我輪值：自己加入',
    '輪值名單：查看循環順序',
    '設定週會 星期二 10:00',
    '設定下次會議 2026/07/21 10:00',
    '輪值：查看下次兩位報告人',
    '請假：本次跳過，下個開會週優先補',
    '管理員：幫請假 + 標註本次報告人',
    '完成：完成報告並排到隊尾',
    '我的ID：查看 LINE User ID',
    '測試提醒：Apps Script 觸發器選 sendTestReminder',
  ].join('\n');
}
