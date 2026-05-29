/**
 * SMS Upgrade Dashboard, SUMMARY tab generator (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Paste this into the SMS logging Google Sheet's Apps Script editor
 * (Extensions -> Apps Script), save, then run `refreshSmsSummary` once to
 * authorize and build the SUMMARY tab. Use `installHourlyTrigger` to keep it
 * refreshing automatically.
 *
 * WHAT IT DOES
 * It reads the existing "SMS" tab (written by the bot's logSmsChatMessages) and
 * rolls it up into a plain-language "SUMMARY" tab a non-engineer can read at a
 * glance. It does NOT change the SMS tab and does NOT touch Boulevard, Twilio,
 * or any member. Read-only over the log, write-only to the SUMMARY tab.
 *
 * WHAT THE SMS TAB CONTAINS (columns A-I)
 *   A Session ID | B Timestamp | C Direction (inbound/outbound) | D Phone
 *   E Member Name | F Location | G Message Content | H Offer Type | I Outcome
 *
 * IMPORTANT LIMITATION (read this)
 * The bot logs a row only for SENDS and for REPLIES. It does NOT log a row when
 * a candidate is SKIPPED (klaviyo_not_subscribed, cooldown, etc.) or when a send
 * ERRORS. So this dashboard can show sends, replies, YES count, by-location, and
 * last-send time, but it CANNOT show "skips by reason" or "error count" from
 * the Sheet alone. Those two live in Vercel cron logs (summary.skippedByReason /
 * summary.errorsByReason) and Sentry. The dashboard surfaces that fact instead
 * of showing a misleading "0". See docs/SMS_DASHBOARD_FIELD_SPEC.md for the small
 * code change that would bring skips/errors into the Sheet.
 */

var SMS_TAB = 'SMS';
var SUMMARY_TAB = 'SUMMARY';
var TZ = 'America/New_York'; // the timezone the team reads in

// Outcomes that mean "we actually sent an outbound upgrade text".
var SENT_OUTCOMES = ['initial_sent', 'reminder_sent'];

function _todayStr_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function _rowDateStr_(tsValue) {
  if (!tsValue) return '';
  var d = (tsValue instanceof Date) ? tsValue : new Date(tsValue);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function _isAffirmative_(text) {
  return /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|yes please|do it|sounds good|please)\b/i.test(String(text || ''));
}

function _minutesAgo_(tsValue) {
  if (!tsValue) return null;
  var d = (tsValue instanceof Date) ? tsValue : new Date(tsValue);
  if (isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 60000);
}

/**
 * Build / refresh the SUMMARY tab. Run this from the editor once to authorize.
 */
function refreshSmsSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(SMS_TAB);
  if (!src) {
    throw new Error('No "' + SMS_TAB + '" tab found. The bot creates it on the first SMS log write.');
  }

  var values = src.getDataRange().getValues();
  // Row 0 is the header. Columns: 0 Session,1 Timestamp,2 Direction,3 Phone,
  // 4 Member,5 Location,6 Content,7 Offer Type,8 Outcome.
  var today = _todayStr_();

  var sendsToday = 0;
  var repliesToday = 0;
  var yesToday = 0;
  var sendsByLocation = {}; // location -> count
  var lastSendTs = null;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var ts = row[1];
    var direction = String(row[2] || '').toLowerCase();
    var location = String(row[5] || '').trim() || '(unknown)';
    var content = row[6];
    var outcome = String(row[8] || '').toLowerCase();
    var dateStr = _rowDateStr_(ts);

    var isSend = direction === 'outbound' && SENT_OUTCOMES.indexOf(outcome) !== -1;
    if (isSend) {
      // Track the most recent send across all time (so a stall is visible even
      // if it started yesterday).
      var d = (ts instanceof Date) ? ts : new Date(ts);
      if (!isNaN(d.getTime()) && (!lastSendTs || d.getTime() > lastSendTs.getTime())) lastSendTs = d;
    }

    if (dateStr !== today) continue; // everything below is "today only"

    if (isSend) {
      sendsToday++;
      sendsByLocation[location] = (sendsByLocation[location] || 0) + 1;
    }
    if (direction === 'inbound') {
      repliesToday++;
      if (_isAffirmative_(content)) yesToday++;
    }
  }

  // ---- write the SUMMARY tab ----
  var out = ss.getSheetByName(SUMMARY_TAB);
  if (!out) out = ss.insertSheet(SUMMARY_TAB, 0);
  out.clear();

  var minsAgo = _minutesAgo_(lastSendTs);
  var lastSendDisplay = lastSendTs
    ? Utilities.formatDate(lastSendTs, TZ, 'EEE MMM d, h:mm a') + (minsAgo != null ? '  (' + minsAgo + ' min ago)' : '')
    : 'No sends recorded yet';
  var lastSendStall = (minsAgo != null && minsAgo > 180); // >3h gap flag

  var rows = [
    ['SMS Upgrade Dashboard', ''],
    ['Last refreshed', Utilities.formatDate(new Date(), TZ, 'EEE MMM d, yyyy h:mm a') + ' ET'],
    ['Showing', 'Today (' + today + ', ' + TZ + ')'],
    ['', ''],
    ['TODAY AT A GLANCE', ''],
    ['Sends today', sendsToday],
    ['Last successful send', lastSendDisplay],
    ['Replies received today', repliesToday],
    ['YES replies today (approx)', yesToday],
    ['', ''],
    ['WATCH NUMBERS (not in this Sheet, see runbook)', ''],
    ['Errors today', 'Not logged here, check Sentry / Vercel logs / ops-alert email'],
    ['Skips by reason', 'Not logged here, check Vercel cron summary.skippedByReason'],
    ['Boulevard health', 'Run: node scripts/boulevard-health-check.mjs'],
    ['', ''],
    ['SENDS BY LOCATION (today)', ''],
  ];

  var locNames = Object.keys(sendsByLocation).sort();
  if (locNames.length === 0) {
    rows.push(['(no sends today yet)', '']);
  } else {
    for (var i = 0; i < locNames.length; i++) {
      rows.push([locNames[i], sendsByLocation[locNames[i]]]);
    }
  }

  out.getRange(1, 1, rows.length, 2).setValues(rows);

  // ---- light formatting so it reads like a dashboard, not a data dump ----
  out.setColumnWidth(1, 360);
  out.setColumnWidth(2, 420);
  out.getRange('A1').setFontSize(16).setFontWeight('bold');
  out.getRange('A5').setFontWeight('bold').setBackground('#e8eaed');
  out.getRange('A11').setFontWeight('bold').setBackground('#fce8e6'); // light red, the watch section
  out.getRange('A16').setFontWeight('bold').setBackground('#e8eaed');
  out.getRange('B6').setFontSize(14).setFontWeight('bold'); // sends today
  out.getRange('B9').setFontSize(14).setFontWeight('bold'); // yes today

  // Flag a stalled pipeline in plain sight.
  if (lastSendStall) {
    out.getRange('B7').setBackground('#fce8e6').setFontWeight('bold');
  }
  out.setFrozenRows(3);
}

/**
 * Install a time-driven trigger so the SUMMARY tab refreshes automatically.
 * Run once. Hourly is plenty for a human-watch dashboard; change to
 * everyMinutes(15) if you want it tighter during go-live day.
 */
function installHourlyTrigger() {
  // Remove any existing triggers for this function first to avoid duplicates.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'refreshSmsSummary') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('refreshSmsSummary').timeBased().everyHours(1).create();
}
