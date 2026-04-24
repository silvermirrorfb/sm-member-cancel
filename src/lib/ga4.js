// VC-1 skeleton. VC-8 will implement the Measurement Protocol send.
// Signature is frozen so callers don't need to change when internals swap.

async function fireGa4Event(eventName, params) {
  const name = String(eventName || '').trim();
  if (!name) return;
  const payload = params && typeof params === 'object' ? params : {};
  console.log('GA4:', name, payload);
}

export { fireGa4Event };
