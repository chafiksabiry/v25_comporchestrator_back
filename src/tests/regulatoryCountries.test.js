// Run: node --test src/tests/regulatoryCountries.test.js
// États-Unis et Canada : Twilio n'exige aucun Regulatory Bundle pour un numéro local (absents de
// https://www.twilio.com/en-us/guidelines/regulatory). L'API Regulations renvoie pourtant des régulations pour ces pays : elles ne
// doivent plus bloquer la recherche, la disponibilité Nomad Solo ni le contrôle avant paiement. France et Royaume-Uni : inchangés.
// Twilio simulé : aucun appel réel.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
process.env.TWILIO_FRENCH_BUNDLE_SID = 'BUfr000000000000000000000000000001';
process.env.TWILIO_GB_BUNDLE_SID = '';

const { phoneNumberService, NO_LOCAL_BUNDLE_COUNTRIES } = await import('../services/phoneNumberService.js');
const { countryAvailability, clearAvailabilityCache } = await import('../services/numberAvailability.js');

const SAMPLE = {
  US: '+12025550101',
  CA: '+14165550101',
  GB: '+442071234567',
  FR: '+33123456789',
};

/** Twilio simulé : l'API Regulations renvoie une régulation pour TOUS les pays (comme en production pour US, GB, CA). */
function fakeTwilio({ approved = [] } = {}) {
  const calls = { regulations: [], search: [] };
  const client = {
    numbers: {
      v2: {
        regulatoryCompliance: {
          regulations: {
            list: async (opts) => {
              calls.regulations.push(opts);
              return [{ sid: 'RNx', isoCountry: opts.isoCountry, numberType: opts.numberType, endUserType: 'business' }];
            },
          },
          bundles: (sid) => ({ fetch: async () => ({ sid, status: approved.includes(sid) ? 'twilio-approved' : 'draft' }) }),
        },
      },
    },
    availablePhoneNumbers: (cc) => ({
      local: {
        list: async () => {
          calls.search.push(cc);
          return [{ phoneNumber: SAMPLE[cc], friendlyName: SAMPLE[cc], isoCountry: cc, capabilities: { voice: true } }];
        },
      },
    }),
    incomingPhoneNumbers: { list: async () => [] },
  };
  return { client, calls };
}

let twilio;
beforeEach(() => {
  twilio = fakeTwilio({ approved: ['BUfr000000000000000000000000000001'] });
  phoneNumberService.twilioClient = twilio.client;
  clearAvailabilityCache();
});

describe('isRegulatoryBundleRequired', () => {
  it('US et CA : aucun dossier pour un numéro local, sans même interroger Twilio', async () => {
    assert.deepEqual([...NO_LOCAL_BUNDLE_COUNTRIES], ['US', 'CA']);
    assert.equal(await phoneNumberService.isRegulatoryBundleRequired('US', 'local'), false);
    assert.equal(await phoneNumberService.isRegulatoryBundleRequired('ca'), false);
    assert.equal(twilio.calls.regulations.length, 0);
  });

  it('FR et GB : toujours exigé quand Twilio renvoie une régulation', async () => {
    assert.equal(await phoneNumberService.isRegulatoryBundleRequired('FR', 'local'), true);
    assert.equal(await phoneNumberService.isRegulatoryBundleRequired('GB', 'local'), true);
    assert.deepEqual(twilio.calls.regulations.map((o) => o.isoCountry), ['FR', 'GB']);
  });

  it('US hors numéro local (toll-free…) : la réponse de Twilio reste appliquée', async () => {
    assert.equal(await phoneNumberService.isRegulatoryBundleRequired('US', 'toll-free'), true);
  });
});

describe('searchTwilioNumbers', () => {
  it('US et CA : la recherche Twilio a lieu sans dossier', async () => {
    const us = await phoneNumberService.searchTwilioNumbers({ countryCode: 'US' });
    const ca = await phoneNumberService.searchTwilioNumbers({ countryCode: 'CA' });
    assert.deepEqual(us.map((n) => n.phoneNumber), [SAMPLE.US]);
    assert.deepEqual(ca.map((n) => n.phoneNumber), [SAMPLE.CA]);
    assert.deepEqual(twilio.calls.search, ['US', 'CA']);
  });

  it('GB sans dossier configuré : toujours bloqué (REGULATORY_BUNDLE_REQUIRED)', async () => {
    await assert.rejects(phoneNumberService.searchTwilioNumbers({ countryCode: 'GB' }), (e) => e.code === 'REGULATORY_BUNDLE_REQUIRED' && e.countryCode === 'GB');
    assert.deepEqual(twilio.calls.search, []);
  });

  it('FR avec dossier approuvé : inchangé', async () => {
    const fr = await phoneNumberService.searchTwilioNumbers({ countryCode: 'FR' });
    assert.deepEqual(fr.map((n) => n.phoneNumber), [SAMPLE.FR]);
  });

  it('FR avec dossier non approuvé : toujours bloqué', async () => {
    phoneNumberService.twilioClient = fakeTwilio({ approved: [] }).client;
    await assert.rejects(phoneNumberService.searchTwilioNumbers({ countryCode: 'FR' }), (e) => e.code === 'REGULATORY_BUNDLE_REQUIRED');
  });
});

describe('disponibilité Nomad Solo (stock vide)', () => {
  it('US et CA disponibles, GB « regulatory », FR disponible', async () => {
    assert.deepEqual(await countryAvailability('US', { fresh: true }), { available: true });
    assert.deepEqual(await countryAvailability('CA', { fresh: true }), { available: true });
    assert.deepEqual(await countryAvailability('GB', { fresh: true }), { available: false, reason: 'regulatory' });
    assert.deepEqual(await countryAvailability('FR', { fresh: true }), { available: true });
  });
});
