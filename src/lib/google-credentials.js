import crypto from 'crypto';

// Parse the Google service-account JSON from its env value WITHOUT ever letting
// the raw value (which contains a private key) reach an error message, stack, or
// log line.
//
// Why this exists: a bare `JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)` on a malformed
// value throws a SyntaxError, and when that error is printed uncaught the runtime
// echoes the INPUT string as source context. That leaked the service-account
// private key into a transcript four times. This wrapper catches the parse failure
// and throws a brand-new, REDACTED Error (length + short sha256 fingerprint only),
// so no key material can ever be serialized, no matter where the error is caught,
// logged, or printed.
export function parseGoogleServiceAccount(raw) {
  if (raw == null || String(raw).trim() === '') {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  }
  const text = String(raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never include `text` or the caught SyntaxError (its display echoes the input).
    // A length + short fingerprint is enough to tell two bad values apart in a log.
    const fingerprint = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (length=${text.length}, sha256:${fingerprint}). Store it as a single line of valid JSON.`,
    );
  }
  const emailOk = typeof parsed?.client_email === 'string' && parsed.client_email.trim() !== '';
  const keyOk = typeof parsed?.private_key === 'string' && parsed.private_key.trim() !== '';
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !emailOk || !keyOk) {
    // Redacted shape error; never echo the parsed object, it holds the private key.
    // Owning this validation (not GoogleAuth) keeps malformed values on the redacted path.
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON parsed but is missing or has a non-string client_email/private_key.');
  }
  return parsed;
}
