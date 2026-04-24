import { NextResponse } from 'next/server';
import { isValidTwilioSignature, parseTwilioFormBody } from '../../../../lib/twilio';
import { mapTwilioNumberToLocation, getLocationLandline } from '../../../../lib/voice-number-map';
import { fireGa4Event } from '../../../../lib/ga4';

const TWIML_HEADERS = { 'Content-Type': 'text/xml; charset=utf-8' };
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

function escapeXmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDialTwiml({ statusCallbackUrl, landline }) {
  const action = escapeXmlAttr(statusCallbackUrl);
  const target = escapeXmlAttr(landline);
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" answerOnBridge="true" action="${action}" method="POST">${target}</Dial></Response>`;
}

function resolveAppUrl() {
  return String(process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
}

export async function POST(request) {
  try {
    const rawBody = await request.text();
    const form = parseTwilioFormBody(rawBody);

    const providedSignature = request.headers.get('x-twilio-signature');
    const validSignature = isValidTwilioSignature({
      url: request.url,
      params: form,
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      providedSignature,
    });
    if (!validSignature) {
      return NextResponse.json(
        { error: 'Invalid Twilio signature.' },
        { status: 403 },
      );
    }

    const called = String(form.Called || '').trim();
    const callSid = String(form.CallSid || '').trim();
    const callerPhone = String(form.From || '').trim();

    if (!called) {
      console.error('[voice-webhook] missing Called parameter', { callSid });
      return new NextResponse(EMPTY_TWIML, { status: 400, headers: TWIML_HEADERS });
    }

    let location;
    try {
      location = mapTwilioNumberToLocation(called);
    } catch (mapErr) {
      console.error('[voice-webhook] unknown Called number', {
        callSid,
        called,
        error: mapErr.message,
      });
      return new NextResponse(EMPTY_TWIML, { status: 400, headers: TWIML_HEADERS });
    }

    const landline = getLocationLandline(location);

    fireGa4Event('call_received', { location, callSid, callerPhone }).catch(err => {
      console.warn('[voice-webhook] ga4 call_received failed:', err?.message || err);
    });

    const appUrl = resolveAppUrl();
    if (!appUrl) {
      console.error('[voice-webhook] NEXT_PUBLIC_APP_URL is not configured; dial action URL will be invalid');
    }
    const statusCallbackUrl = `${appUrl}/api/voice/status`;

    const twiml = buildDialTwiml({ statusCallbackUrl, landline });
    return new NextResponse(twiml, { status: 200, headers: TWIML_HEADERS });
  } catch (err) {
    console.error('[voice-webhook] unexpected error:', err?.message || err);
    return new NextResponse(EMPTY_TWIML, { status: 500, headers: TWIML_HEADERS });
  }
}
