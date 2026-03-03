import nodemailer from 'nodemailer';

function isNilLike(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' || trimmed === 'null' || trimmed === 'undefined' || trimmed === 'nan';
}

function toSheetValue(value) {
  return isNilLike(value) ? '' : value;
}

function toCurrencyCell(value, suffix = '') {
  if (isNilLike(value)) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
    return `$${n}${suffix}`;
  }

  const s = String(value);
  const match = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return '';
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return '';
  const n = Number.isInteger(parsed) ? String(parsed) : String(Number(parsed.toFixed(2)));
  return `$${n}${suffix}`;
}

// ── Helper: Get authenticated Google Sheets client ──
async function getSheetsClient() {
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentials) return null;

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentials),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

// ══════════════════════════════════════════════════════════════
// EMAIL FUNCTIONS
// ══════════════════════════════════════════════════════════════

/**
 * Send the session summary email to memberships@silvermirror.com
 */
async function sendSummaryEmail(summary, transcript) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || 'info@silvermirror.com';

  // Always send to memberships@. If member is upset, also send to hello@.
  const UPSET_SENTIMENTS = ['frustrated', 'angry', 'upset', 'hostile', 'furious', 'irritated', 'disappointed'];
  const sentiment = (summary.member_sentiment || '').toLowerCase();
  const isUpset = UPSET_SENTIMENTS.some(s => sentiment.includes(s));

  const primaryTo = process.env.EMAIL_TO || 'memberships@silvermirror.com';
  const escalationTo = process.env.EMAIL_ESCALATION || 'hello@silvermirror.com';
  const to = isUpset ? `${primaryTo}, ${escalationTo}` : primaryTo;

  if (!host || !user || !pass) {
    console.warn('SMTP not configured \u2014 email not sent for session:', summary.client_name, '| outcome:', summary.outcome);
    return { sent: false, reason: 'SMTP not configured' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const subject = buildSubjectLine(summary);
  const html = buildEmailHtml(summary, transcript);
  const text = buildEmailBody(summary, transcript);

  try {
    await transporter.sendMail({ from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error('Email send failed:', err);
    return { sent: false, reason: err.message };
  }
}

function buildSubjectLine(summary) {
  const outcome = summary.outcome || 'UNKNOWN';
  const name = summary.client_name || 'Unknown Member';
  const reason = summary.reason_primary || 'Unknown';
  const UPSET_SENTIMENTS = ['frustrated', 'angry', 'upset', 'hostile', 'furious', 'irritated', 'disappointed'];
  const sentiment = (summary.member_sentiment || '').toLowerCase();
  const isUpset = UPSET_SENTIMENTS.some(s => sentiment.includes(s));
  const flag = isUpset ? '🔴 ESCALATION — ' : '';
  return `${flag}[Cancel Bot] ${outcome} — ${name} — ${reason}`;
}

function buildEmailBody(summary, transcript) {
  const walkinSavingsText = toCurrencyCell(summary.walkin_savings) || 'N/A';
  const rateLockSavingsText = toCurrencyCell(summary.rate_lock_savings_annual, '/year') || 'Rate matches current';

  return `
======================================
SILVER MIRROR — CANCELLATION SESSION SUMMARY
======================================

Date: ${summary.date}
Client Name: ${summary.client_name}
Email: ${summary.email}
Phone: ${summary.phone || 'Not provided'}
Location: ${summary.location}
Membership Tier: ${summary.membership_tier}-Minute
Monthly Rate: $${summary.monthly_rate}
Tenure: ${summary.tenure_months} months
Account Status: ${summary.account_status}

MEMBER VALUE AT TIME OF CONVERSATION:
- Loyalty points: ${summary.loyalty_points} points${summary.loyalty_redeemable ? ` (redeemable for ${summary.loyalty_redeemable})` : ''}
- Walk-in savings: ${walkinSavingsText}
- Rate lock savings: ${rateLockSavingsText}
- Unused credits: ${summary.unused_credits}
- Next perk: Month ${summary.next_perk_month} — ${summary.next_perk_name} ($${summary.next_perk_value})
- Perks claimed: ${summary.perks_claimed || 'None'}

CANCELLATION REASON:
- Primary: ${summary.reason_primary}
- Secondary: ${summary.reason_secondary || 'None'}
- Member's words: "${summary.reason_verbatim}"

OUTCOME: ${summary.outcome}

${summary.outcome === 'RETAINED' ? `RETENTION DETAILS:
- Offer accepted: ${summary.offer_accepted}
- 3-cycle commitment disclosed: ${summary.commitment_disclosed ? 'Yes' : 'No'}
- Lead recommended: ${summary.lead_recommended || 'N/A'}` : ''}

${summary.outcome === 'CANCELLED' ? `CANCELLATION DETAILS:
- Offers presented: ${(summary.offers_presented || []).join(' → ')}
- All declined: ${summary.all_declined ? 'Yes' : 'No'}` : ''}

ACTION REQUIRED:
${summary.action_required}

COST TO SILVER MIRROR: ${summary.cost_to_company}
MEMBER SENTIMENT: ${summary.member_sentiment}

======================================
FULL TRANSCRIPT
======================================
${transcript}
`.trim();
}

function buildEmailHtml(summary, transcript) {
  const esc = (str) => String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const walkinSavingsText = toCurrencyCell(summary.walkin_savings) || 'N/A';
  const rateLockSavingsText = toCurrencyCell(summary.rate_lock_savings_annual, '/year') || 'Matches current';

  const outcomeColor = {
    'RETAINED': '#4CAF50',
    'CANCELLED': '#F44336',
    'MANAGER_CALLBACK': '#FF9800',
    'REFERRED': '#2196F3',
    'INCOMPLETE': '#666',
  }[summary.outcome] || '#666';

  return `
<!DOCTYPE html>
<html>
<head><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 700px; margin: 0 auto; }
  .header { background: #1B365D; color: white; padding: 20px; text-align: center; }
  .outcome { display: inline-block; background: ${outcomeColor}; color: white; padding: 8px 20px; border-radius: 4px; font-weight: bold; font-size: 18px; margin: 16px 0; }
  .section { border: 1px solid #ddd; padding: 16px; margin: 12px 0; border-radius: 6px; }
  .section h3 { margin-top: 0; color: #1B365D; border-bottom: 2px solid #1B365D; padding-bottom: 6px; }
  .label { font-weight: bold; color: #555; }
  .action { background: #FFF3E0; border-left: 4px solid #FF9800; padding: 12px 16px; margin: 12px 0; }
  .transcript { background: #f5f5f5; padding: 16px; font-size: 13px; white-space: pre-wrap; border-radius: 4px; max-height: 600px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  td:first-child { width: 180px; }
</style></head>
<body>
  <div class="header">
    <h2 style="margin:0;">Cancellation Session Summary</h2>
    <div style="opacity:0.8;">${esc(summary.date)}</div>
  </div>

  <div style="text-align:center;"><span class="outcome">${esc(summary.outcome)}</span></div>

  <div class="section">
    <h3>Member Info</h3>
    <table>
      <tr><td class="label">Name</td><td>${esc(summary.client_name)}</td></tr>
      <tr><td class="label">Email</td><td>${esc(summary.email)}</td></tr>
      <tr><td class="label">Phone</td><td>${esc(summary.phone || 'Not provided')}</td></tr>
      <tr><td class="label">Location</td><td>${esc(summary.location)}</td></tr>
      <tr><td class="label">Tier</td><td>${esc(summary.membership_tier)}-Minute at $${esc(summary.monthly_rate)}/mo</td></tr>
      <tr><td class="label">Tenure</td><td>${esc(summary.tenure_months)} months</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Value at Risk</h3>
    <table>
      <tr><td class="label">Loyalty Points</td><td>${esc(summary.loyalty_points)}${summary.loyalty_redeemable ? ` (${esc(summary.loyalty_redeemable)})` : ''}</td></tr>
      <tr><td class="label">Walk-in Savings</td><td>${esc(walkinSavingsText)}</td></tr>
      <tr><td class="label">Rate Lock Savings</td><td>${esc(rateLockSavingsText)}</td></tr>
      <tr><td class="label">Unused Credits</td><td>${esc(summary.unused_credits)}</td></tr>
      <tr><td class="label">Next Perk</td><td>Month ${esc(summary.next_perk_month)}: ${esc(summary.next_perk_name)} ($${esc(summary.next_perk_value)})</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Reason</h3>
    <table>
      <tr><td class="label">Primary</td><td><strong>${esc(summary.reason_primary)}</strong></td></tr>
      <tr><td class="label">Secondary</td><td>${esc(summary.reason_secondary || 'None')}</td></tr>
      <tr><td class="label">In Their Words</td><td><em>"${esc(summary.reason_verbatim)}"</em></td></tr>
    </table>
  </div>

  <div class="action">
    <strong>ACTION REQUIRED:</strong><br/>
    ${esc(summary.action_required)}
  </div>

  <div class="section">
    <h3>Details</h3>
    <table>
      <tr><td class="label">Offers Presented</td><td>${esc((summary.offers_presented || []).join(' → ') || 'None')}</td></tr>
      <tr><td class="label">Offer Accepted</td><td>${esc(summary.offer_accepted || 'None')}</td></tr>
      <tr><td class="label">3-Cycle Commitment</td><td>${summary.commitment_disclosed ? 'Disclosed & accepted' : 'N/A'}</td></tr>
      <tr><td class="label">Lead Recommended</td><td>${esc(summary.lead_recommended || 'N/A')}</td></tr>
      <tr><td class="label">Cost to SM</td><td>${esc(summary.cost_to_company)}</td></tr>
      <tr><td class="label">Member Sentiment</td><td>${esc(summary.member_sentiment)}</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Full Transcript</h3>
    <div class="transcript">${esc(transcript)}</div>
  </div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════
// GOOGLE SHEETS — CANCELLATION SUMMARY (membership conversations only)
// Sheet: GOOGLE_SHEET_ID → "Cancellations" tab
// Columns A-V (22 columns matching your existing headers)
// ══════════════════════════════════════════════════════════════

async function logToGoogleSheets(summary) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    console.warn('GOOGLE_SHEET_ID not configured — skipping cancellation log');
    return { logged: false, reason: 'Not configured' };
  }

  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { logged: false, reason: 'Google credentials not configured' };

    // 22 columns: A-V matching headers in the Cancellations sheet
    const row = [
      toSheetValue(summary.date) || new Date().toISOString(),                 // A: Date
      toSheetValue(summary.sheet_month) || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }), // B: Month
      toSheetValue(summary.client_name),                                      // C: Client Name
      toSheetValue(summary.phone),                                            // D: Phone
      toSheetValue(summary.location),                                         // E: Location
      toSheetValue(summary.membership_tier),                                  // F: Tier
      toSheetValue(summary.monthly_rate),                                     // G: Monthly Rate
      toSheetValue(summary.tenure_months),                                    // H: Tenure (Months)
      toSheetValue(summary.reason_primary),                                   // I: V1 (Primary Reason)
      toSheetValue(summary.reason_secondary),                                 // J: Secondary Reason
      toSheetValue(summary.reason_verbatim),                                  // K: Member's Words
      toSheetValue(summary.outcome),                                          // L: Outcome
      toSheetValue(summary.offer_accepted),                                   // M: Offer Accepted
      toSheetValue((summary.offers_presented || []).join(' → ')),             // N: Offers Presented
      toSheetValue(summary.action_required),                                  // O: Action Required
      toSheetValue(summary.cost_to_company),                                  // P: Cost to SM
      toSheetValue(summary.member_sentiment),                                 // Q: Member Sentiment
      toSheetValue(summary.loyalty_points),                                   // R: Loyalty Points
      toCurrencyCell(summary.walkin_savings),                                 // S: Walk-in Savings
      toCurrencyCell(summary.rate_lock_savings_annual, '/yr'),                // T: Rate Lock Savings
      toSheetValue(summary.unused_credits),                                   // U: Unused Credits
      toSheetValue(summary.lead_recommended),                                 // V: Lead Recommended
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Cancellations!A:V',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    return { logged: true };
  } catch (err) {
    console.error('Cancellation sheet logging failed:', err);
    return { logged: false, reason: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// GOOGLE SHEETS — CHATBOT MESSAGE LOG (ALL conversations)
// Sheet: GOOGLE_CHATLOG_SHEET_ID → "Sheet1" tab
// Columns: Session ID | Session Created | Session Updated | Message Role | Message Content
// ══════════════════════════════════════════════════════════════

async function logChatMessage(sessionId, sessionCreated, role, content) {
  const sheetId = process.env.GOOGLE_CHATLOG_SHEET_ID;
  if (!sheetId) {
    console.warn('GOOGLE_CHATLOG_SHEET_ID not configured — skipping message log');
    return { logged: false, reason: 'Not configured' };
  }

  try {
    const sheets = await getSheetsClient();
    if (!sheets) return { logged: false, reason: 'Google credentials not configured' };

    const now = new Date().toISOString();

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          sessionId,
          sessionCreated,
          now,
          role,
          content,
        ]],
      },
    });

    return { logged: true };
  } catch (err) {
    console.error('Chat message logging failed:', err);
    return { logged: false, reason: err.message };
  }
}

// ══════════════════════════════════════════════════════════════
// COMBINED: Process end of membership conversation
// ══════════════════════════════════════════════════════════════

async function processConversationEnd(summary, transcript) {
  const [emailResult, sheetResult] = await Promise.allSettled([
    sendSummaryEmail(summary, transcript),
    logToGoogleSheets(summary),
  ]);

  return {
    email: emailResult.status === 'fulfilled' ? emailResult.value : { sent: false, reason: emailResult.reason?.message },
    sheet: sheetResult.status === 'fulfilled' ? sheetResult.value : { logged: false, reason: sheetResult.reason?.message },
  };
}

export {
  sendSummaryEmail,
  logToGoogleSheets,
  logChatMessage,
  processConversationEnd,
};
