/**
 * France phone lines are always provisioned via Twilio (Regulatory Bundle).
 * Other markets default to Telnyx unless the client explicitly asks for Twilio.
 */

export function isFrenchPhoneNumber(phoneNumber) {
  const raw = String(phoneNumber || '').replace(/[^\d+]/g, '');
  return raw.startsWith('+33');
}

export function isFrenchCountry(countryCode) {
  return String(countryCode || '').trim().toUpperCase() === 'FR';
}

/**
 * @param {string|null|undefined} provider
 * @param {{ phoneNumber?: string, countryCode?: string }} ctx
 * @returns {'twilio'|'telnyx'}
 */
export function resolvePhoneProvider(provider, { phoneNumber, countryCode } = {}) {
  if (isFrenchPhoneNumber(phoneNumber) || isFrenchCountry(countryCode)) {
    return 'twilio';
  }
  const p = String(provider || '').toLowerCase();
  if (p === 'twilio' || p === 'telnyx') return p;
  return 'telnyx';
}
