# Silver Mirror — Cancellation Assistant Bot

AI-powered membership cancellation chat widget. Uses Claude (Anthropic) to have natural conversations with members considering cancellation, presents retention offers based on a 20-reason decision tree, and emails structured summaries to the membership team.

## Architecture

```
WordPress Page (silvermirror.com/cancel-membership)
  └── iframe → Vercel (this app)
        ├── /widget — Chat UI (React)
        ├── /api/chat/start — Auth + session init
        ├── /api/chat/message — Conversation turns
        └── /api/chat/end — Summary + notifications
              ├── Email → memberships@silvermirror.com
              └── Google Sheets → Cancellation tracker
```

**Flow:**
1. Member visits cancellation page on WordPress
2. Widget loads in iframe, asks for name + email/phone
3. Middleware looks up member in Boulevard API
4. Claude conversation begins with member profile injected
5. Bot follows decision tree (20 reasons × 3 offers each)
6. On conclusion, structured summary is emailed + logged
7. Membership team executes action in Boulevard manually

## Tech Stack

- **Next.js 14** — App Router, API routes
- **Claude Sonnet** (Anthropic API) — Conversation engine
- **Boulevard Enterprise API** — Member authentication & profile data
- **Nodemailer** — Email delivery to membership team
- **Google Sheets API** — Cancellation tracking
- **Upstash Redis** — Shared rate limiting across serverless instances
- **Vercel** — Hosting & deployment

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd sm-cancel-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your credentials. At minimum you need:
- `ANTHROPIC_API_KEY` — Get from console.anthropic.com

For full functionality also set:
- `BOULEVARD_API_KEY`, `BOULEVARD_API_SECRET`, `BOULEVARD_BUSINESS_ID` — For real member lookup (without key, uses mock data)
- SMTP settings — For emailing summaries (without it, logs to console)
- Google Sheets credentials — For tracking (without it, logs to console)

### 3. Run locally

```bash
npm run dev
```

Visit:
- `http://localhost:3000` — Status page
- `http://localhost:3000/widget` — Chat widget

### 4. Deploy to Vercel

```bash
npx vercel
```

Or connect the Git repo in the Vercel dashboard. Add all environment variables in the Vercel project settings.

### 5. Embed on WordPress

After deploying, get your Vercel URL (e.g., `sm-cancel-bot.vercel.app`).

Create a page at `silvermirror.com/cancel-membership` and add this HTML block:

```html
<div style="width:100%;max-width:520px;margin:0 auto;height:700px;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.12);">
  <iframe 
    src="https://sm-cancel-bot.vercel.app/widget" 
    style="width:100%;height:100%;border:none;" 
    title="Silver Mirror Membership Assistant"
  ></iframe>
</div>
```

## Key Files

| File | What It Does |
|------|-------------|
| `src/lib/system-prompt.txt` | The bot's entire brain — edit this to change behavior |
| `src/lib/boulevard.js` | Boulevard API client + computed values (savings, perks, points) |
| `src/lib/claude.js` | Claude API client + session summary parser |
| `src/lib/notify.js` | Email sender + Google Sheets logger |
| `src/lib/sessions.js` | In-memory session store (swap to Redis for scale) |
| `src/app/widget/page.js` | Chat UI component |
| `src/app/api/chat/*/route.js` | API endpoints |
| `public/embed.html` | WordPress embed snippet (2 options) |

## Boulevard API Integration

The `boulevard.js` module is set up for Boulevard's Enterprise GraphQL API. You'll need to:

1. **Get API credentials** from Boulevard dashboard
2. **Map the data fields** — The `buildProfile()` function in `boulevard.js` shows exactly what fields we need. Map these to Boulevard's actual GraphQL schema:
   - Client lookup by name + email/phone
   - Membership tier, rate, start date
   - Visit history and facial counts
   - Loyalty points balance
   - Unused credits/vouchers
   - Purchase history (for savings calculation)

3. **Test with mock data first** — Without `BOULEVARD_API_KEY` set, the bot returns a realistic test profile so you can verify the full flow works end-to-end.

## Customizing the Bot

### Change bot behavior
Edit `src/lib/system-prompt.txt`. This is the entire system prompt sent to Claude. Changes take effect on next conversation (no rebuild needed if you're editing on Vercel).

### Change offers for a reason
Find the reason in the DECISION TREE section of the system prompt. Add/remove/reorder offers.

### Add a new cancellation reason
Add it to the Decision Tree section with its 3 offers. The bot will automatically match it when members describe that situation.

### Change lead estheticians
Update the LOCATION LEADS ROSTER in the system prompt.

### Change pricing
Update the MEMBERSHIP TIERS AND PRICING section.

## Cost Estimate

- **Claude API**: ~$0.02–0.05 per conversation (Sonnet, ~6-8 turns avg)
- **Vercel**: Free tier handles this easily
- **Monthly total**: $20–50/month at current cancellation volume

## Production Checklist

- [ ] Set ANTHROPIC_API_KEY in Vercel
- [ ] Wire up Boulevard API and test member lookup
- [ ] Configure Upstash Redis for shared rate limiting on production routes
- [ ] Configure SMTP for email delivery
- [ ] Set up Google Sheet and service account
- [ ] Update ALLOWED_ORIGIN to silvermirror.com
- [ ] Embed widget on WordPress cancellation page
- [ ] Test full flow: auth → conversation → offers → summary email
- [ ] Replace in-memory sessions with Redis if needed for reliability
- [ ] Monitor Claude API costs in Anthropic dashboard
