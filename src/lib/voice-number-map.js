const VOICE_NUMBER_MAP = {
  [String(process.env.TWILIO_BRICKELL_VOICE_NUMBER || '').trim()]: 'brickell',
};

const LOCATION_LANDLINE_MAP = {
  brickell: String(process.env.BRICKELL_LANDLINE || '+17868990600').trim(),
};

if (!String(process.env.TWILIO_BRICKELL_VOICE_NUMBER || '').trim()) {
  console.warn('[voice-number-map] TWILIO_BRICKELL_VOICE_NUMBER is not set; voice webhook will reject all inbound calls until configured.');
}

function mapTwilioNumberToLocation(e164) {
  const key = String(e164 || '').trim();
  if (!key) {
    throw new Error('mapTwilioNumberToLocation: empty Called parameter');
  }
  const slug = VOICE_NUMBER_MAP[key];
  if (!slug) {
    throw new Error(`mapTwilioNumberToLocation: no location configured for number ${key}`);
  }
  return slug;
}

function getLocationLandline(slug) {
  const key = String(slug || '').trim().toLowerCase();
  if (!key) {
    throw new Error('getLocationLandline: empty location slug');
  }
  const landline = LOCATION_LANDLINE_MAP[key];
  if (!landline) {
    throw new Error(`getLocationLandline: no landline configured for location ${key}`);
  }
  return landline;
}

function getKnownVoiceNumbers() {
  return Object.keys(VOICE_NUMBER_MAP).filter(Boolean);
}

function getKnownLocations() {
  return Object.keys(LOCATION_LANDLINE_MAP);
}

export {
  mapTwilioNumberToLocation,
  getLocationLandline,
  getKnownVoiceNumbers,
  getKnownLocations,
};
