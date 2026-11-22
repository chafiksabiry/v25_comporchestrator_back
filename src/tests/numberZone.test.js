// Run: node --test src/tests/numberZone.test.js
// Décision du fondateur (22/11) : « ajouter tous les numéros qui tombent sous l'indicatif US (+1) ». US et CA partagent le +1 :
// stock, disponibilité Nomad et règle de pays acceptent tout numéro +1, dans les deux sens. Les autres pays ne changent pas.
// Twilio simulé : aucun appel réel.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
process.env.TWILIO_GB_BUNDLE_SID = 'BUgb000000000000000000000000000001'; // GB avec dossier approuvé (simulé) : seule la recherche compte ici

const { numberZonePeers, sameNumberZone } = await import('../utils/numberZone.js');
const { numberCountryAllowed } = await import('../utils/europeZone.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { countryAvailability, clearAvailabilityCache } = await import('../services/numberAvailability.js');

const US_NUM = '+12025550101';
const CA_NUM = '+14165550101'; // Toronto : classé « US » par l'indicatif +1
const GB_NUM = '+442071234567';
const FR_NUM = '+33123456789';

describe('zones d’indicatif', () => {
  it('US et CA partagent le +1, dans les deux sens ; les autres pays restent seuls', () => {
    assert.deepEqual(numberZonePeers('CA'), ['CA', 'US']);
    assert.deepEqual(numberZonePeers('us'), ['US', 'CA']);
    assert.deepEqual(numberZonePeers('GB'), ['GB']);
    assert.deepEqual(numberZonePeers(''), []);
    assert.equal(sameNumberZone('CA', 'US'), true);
    assert.equal(sameNumberZone('US', 'CA'), true);
    assert.equal(sameNumberZone('FR', 'FR'), true);
    assert.equal(sameNumberZone('GB', 'US'), false);
    assert.equal(sameNumberZone('MA', 'US'), false);
    assert.equal(sameNumberZone('', ''), false);
  });
});

describe('numberCountryAllowed', () => {
  it('un résident canadien peut prendre un numéro +1 (classé US), et inversement', () => {
    assert.equal(numberCountryAllowed('CA', 'US'), true);
    assert.equal(numberCountryAllowed('US', 'CA'), true);
    assert.equal(numberCountryAllowed('CA', 'CA'), true);
  });
  it('pièce d’identité américaine : numéro US ou CA ; rien ne change pour les autres pays', () => {
    assert.equal(numberCountryAllowed('MA', 'CA', { identityCountry: 'US' }), true);
    assert.equal(numberCountryAllowed('MA', 'US', { identityCountry: 'US' }), true);
    assert.equal(numberCountryAllowed('MA', 'US'), false);
    assert.equal(numberCountryAllowed('CA', 'GB'), false);
    assert.equal(numberCountryAllowed('FR', 'US'), false);
    assert.equal(numberCountryAllowed('FR', 'GB'), true); // zone Europe, inchangée
    assert.equal(numberCountryAllowed('MA', 'FR', { identityCountry: 'FR' }), true);
    assert.equal(numberCountryAllowed('MA', 'GB', { identityCountry: 'FR' }), false);
  });
});

/** Twilio simulé : stock possédé + recherche par pays. */
function fakeTwilio({ owned = [], search = {} } = {}) {
  const calls = { search: [] };
  return {
    calls,
    client: {
      incomingPhoneNumbers: { list: async () => owned.map((phoneNumber) => ({ phoneNumber, sid: `PN${phoneNumber}`, capabilities: { voice: true } })) },
      availablePhoneNumbers: (cc) => ({
        local: { list: async () => { calls.search.push(cc); return (search[cc] || []).map((phoneNumber) => ({ phoneNumber, isoCountry: cc, capabilities: { voice: true } })); } },
      }),
      numbers: {
        v2: {
          regulatoryCompliance: {
            regulations: { list: async (o) => [{ sid: 'RNx', isoCountry: o.isoCountry }] },
            bundles: (sid) => ({ fetch: async () => ({ sid, status: 'twilio-approved' }) }),
          },
        },
      },
    },
  };
}

const realUnassigned = phoneNumberService.unassignedAmong;
let twilio;
const use = (opts) => { twilio = fakeTwilio(opts); phoneNumberService.twilioClient = twilio.client; };
beforeEach(() => {
  clearAvailabilityCache();
  phoneNumberService.unassignedAmong = async (owned) => owned; // aucune entreprise ne détient ces numéros
});

describe('stock (listClaimableInventory)', () => {
  it('CA comme US : tout numéro +1 libre du stock, américain ou canadien ; GB et FR inchangés', async () => {
    use({ owned: [US_NUM, CA_NUM, GB_NUM, FR_NUM] });
    const nums = async (cc) => (await phoneNumberService.listClaimableInventory({ countryCode: cc })).map((n) => n.phoneNumber);
    assert.deepEqual(await nums('CA'), [US_NUM, CA_NUM]);
    assert.deepEqual(await nums('US'), [US_NUM, CA_NUM]);
    assert.deepEqual(await nums('GB'), [GB_NUM]);
    assert.deepEqual(await nums('FR'), [FR_NUM]);
    assert.deepEqual(await nums('MA'), []);
  });
});

describe('disponibilité Nomad (countryAvailability)', () => {
  it('CA disponible grâce à un numéro +1 américain en stock', async () => {
    use({ owned: [US_NUM] });
    assert.deepEqual(await countryAvailability('CA', { fresh: true }), { available: true });
    assert.deepEqual(twilio.calls.search, []);
  });
  it('US disponible grâce à un numéro +1 canadien en stock', async () => {
    use({ owned: [CA_NUM] });
    assert.deepEqual(await countryAvailability('US', { fresh: true }), { available: true });
  });
  it('stock vide : CA cherche au Canada puis aux États-Unis', async () => {
    use({ search: { US: [US_NUM] } });
    assert.deepEqual(await countryAvailability('CA', { fresh: true }), { available: true });
    assert.deepEqual(twilio.calls.search, ['CA', 'US']);
  });
  it('stock vide : US cherche aux États-Unis, puis au Canada', async () => {
    use({ search: { CA: [CA_NUM] } });
    assert.deepEqual(await countryAvailability('US', { fresh: true }), { available: true });
    assert.deepEqual(twilio.calls.search, ['US', 'CA']);
  });
  it('trouvé dès le pays demandé : pas de seconde recherche', async () => {
    use({ search: { CA: [CA_NUM] } });
    assert.deepEqual(await countryAvailability('CA', { fresh: true }), { available: true });
    assert.deepEqual(twilio.calls.search, ['CA']);
  });
  it('rien dans la zone +1 : no_inventory', async () => {
    use({});
    assert.deepEqual(await countryAvailability('CA', { fresh: true }), { available: false, reason: 'no_inventory' });
    assert.deepEqual(twilio.calls.search, ['CA', 'US']);
  });
  it('autres pays : une seule recherche, dans le pays demandé', async () => {
    use({ search: { GB: [GB_NUM] } });
    assert.deepEqual(await countryAvailability('GB', { fresh: true }), { available: true });
    assert.deepEqual(twilio.calls.search, ['GB']);
  });
});

process.on('exit', () => { phoneNumberService.unassignedAmong = realUnassigned; });
