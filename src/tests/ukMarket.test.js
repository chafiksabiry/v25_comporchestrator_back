import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
process.env.TWILIO_GB_BUNDLE_SID = 'BUgb000000000000000000000000000001';
process.env.TWILIO_GB_ADDRESS_SID = 'ADgb000000000000000000000000000001';

const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { config } = await import('../config/env.js');

// Royaume-Uni : le dossier réglementaire vient de la configuration, comme pour la France
assert.equal(config.twilioGbBundleSid, 'BUgb000000000000000000000000000001');
assert.equal(config.twilioGbAddressSid, 'ADgb000000000000000000000000000001');
assert.equal(phoneNumberService.getBundleSidForCountry('GB'), 'BUgb000000000000000000000000000001');
assert.equal(phoneNumberService.getBundleSidForCountry('gb'), 'BUgb000000000000000000000000000001');
assert.equal(phoneNumberService.getBundleSidForCountry('FR'), config.twilioFrenchBundleSid);
assert.equal(phoneNumberService.getBundleSidForCountry('DE'), null);
assert.equal(phoneNumberService.guessCountryFromE164('+442071234567'), 'GB');

// L'achat d'un numéro +44 transmet le dossier et l'adresse britanniques à Twilio (et seulement eux)
const created = [];
phoneNumberService.twilioClient = {
  incomingPhoneNumbers: { create: async (opts) => { created.push(opts); return { sid: 'PNx', phoneNumber: opts.phoneNumber, friendlyName: opts.friendlyName, capabilities: {} }; } },
};
try {
  await phoneNumberService.purchaseTwilioNumber('+442071234567', 'https://x.test', null, 'c1', {});
} catch {
  /* la suite de l'achat (base de données) n'est pas simulée ici : seul l'appel Twilio compte */
}
assert.equal(created.length, 1);
assert.equal(created[0].bundleSid, 'BUgb000000000000000000000000000001');
assert.equal(created[0].addressSid, 'ADgb000000000000000000000000000001');
console.log('ukMarket.test OK');
process.exit(0);
