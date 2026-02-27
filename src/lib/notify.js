import nodemailer from 'nodemailer';

/**
 * Send the session summary email to memberships@silvermirror.com
 */
async function sendSummaryEmail(summary, transcript) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.EMAIL_FROM || 'cancellation-bot@silvermirror.com';
  const to = process.env.EMAIL_TO || 'memberships@silvermirror.com';

  if (!host || !user || !pass) {
    console.warn('SMTP not configured — logging email to console instead');
    console.log('=== EMAIL THAT WOULD BE SENT ===');
    console.log(`To: ${to}`);
    console.log(`Subject: ${buildSubjectLine(summary)}`);
    console.log(buildEmailBody(summary, transcript));
    console.log('=== END EMAIL ===');
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
  return `[Cancel Bot] ${outcome} — ${name} — ${reason}`;
}

function buildEmailBody(summary, transcript) {
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
- Walk-in savings: ${summary.walkin_savings ? `$${summary.walkin_savings}` : 'N/A'}
- Rate lock savings: ${summary.rate_lock_savings_annual ? `$${summary.rate_lock_savings_annual}/year` : 'Rate matches current'}
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
  const outcomeColor = {
    'RETAINED': '#4CAF50',
    'CANCELLED': '#F44336',
    'MANAGER_CALLBACK': '#FF9800',
    'REFERRED': '#2196F3',
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
    <div style="opacity:0.8;">${summary.date}</div>
  </div>

  <div style="text-align:center;"><span class="outcome">${summary.outcome}</span></div>

  <div class="section">
    <h3>Member Info</h3>
    <table>
      <tr><td class="label">Name</td><td>${summary.client_name}</td></tr>
      <tr><td class="label">Email</td><td>${summary.email}</td></tr>
      <tr><td class="label">Phone</td><td>${summary.phone || 'Not provided'}</td></tr>
      <tr><td class="label">Location</td><td>${summary.location}</td></tr>
      <tr><td class="label">Tier</td><td>${summary.membership_tier}-Minute at $${summary.monthly_rate}/mo</td></tr>
      <tr><td class="label">Tenure</td><td>${summary.tenure_months} months</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Value at Risk</h3>
    <table>
      <tr><td class="label">Loyalty Points</td><td>${summary.loyalty_points}${summary.loyalty_redeemable ? ` (${summary.loyalty_redeemable})` : ''}</td></tr>
      <tr><td class="label">Walk-in Savings</td><td>${summary.walkin_savings ? `$${summary.walkin_savings}` : 'N/A'}</td></tr>
      <tr><td class="label">Rate Lock Savings</td><td>${summary.rate_lock_savings_annual ? `$${summary.rate_lock_savings_annual}/year` : 'Matches current'}</td></tr>
      <tr><td class="label">Unused Credits</td><td>${summary.unused_credits}</td></tr>
      <tr><td class="label">Next Perk</td><td>Month ${summary.next_perk_month}: ${summary.next_perk_name} ($${summary.next_perk_value})</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Reason</h3>
    <table>
      <tr><td class="label">Primary</td><td><strong>${summary.reason_primary}</strong></td></tr>
      <tr><td class="label">Secondary</td><td>${summary.reason_secondary || 'None'}</td></tr>
      <tr><td class="label">In Their Words</td><td><em>"${summary.reason_verbatim}"</em></td></tr>
    </table>
  </div>

  <div class="action">
    <strong>ACTION REQUIRED:</strong><br/>
    ${summary.action_required}
  </div>

  <div class="section">
    <h3>Details</h3>
    <table>
      <tr><td class="label">Offers Presented</td><td>${(summary.offers_presented || []).join(' → ') || 'None'}</td></tr>
      <tr><td class="label">Offer Accepted</td><td>${summary.offer_accepted || 'None'}</td></tr>
      <tr><td class="label">3-Cycle Commitment</td><td>${summary.commitment_disclosed ? 'Disclosed & accepted' : 'N/A'}</td></tr>
      <tr><td class="label">Lead Recommended</td><td>${summary.lead_recommended || 'N/A'}</td></tr>
      <tr><td class="label">Cost to SM</td><td>${summary.cost_to_company}</td></tr>
      <tr><td class="label">Member Sentiment</td><td>${summary.member_sentiment}</td></tr>
    </table>
  </div>

  <div class="section">
    <h3>Full Transcript</h3>
    <div class="transcript">${transcript.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  </div>
</body>
</html>`;
}

/**
 * Append a row to Google Sheets for tracking.
 */
async function logToGoogleSheets(summary) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sheetId || !credentials) {
    console.warn('Google Sheets not configured — logging to console');
    console.log('SHEET ROW:', {
      month: summary.sheet_month,
      name: summary.client_name,
      reason: summary.reason_primary,
      solution: summary.sheet_solution,
    });
    return { logged: false, reason: 'Google Sheets not configured' };
  }

  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(credentials),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Cancellations!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          summary.date,
          summary.sheet_month,
          summary.client_name,
          summary.email,
          summary.reason_primary,
          summary.sheet_solution,
        ]],
      },
    });

    return { logged: true };
  } catch (err) {
    console.error('Google Sheets logging failed:', err);
    return { logged: false, reason: err.message };
  }
}

/**
 * Process the end of a conversation: send email + log to sheet.
 */
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
  processConversationEnd,
};
