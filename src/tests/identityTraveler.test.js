// Run: JWT_SECRET=t node --test src/tests/identityTraveler.test.js
// NOMAD Traveler dans le parcours NOMAD (27/11/2026) : la vérification d'identité, en mode Traveler, demande le passeport, le billet et le
// visa (si la nationalité l'exige), SANS adresse ni justificatif de domicile ; décision automatique (jamais de revue par l'équipe) ;
// pièces validées enregistrées pour la garde du paiement Traveler ; pays ouvert = pays du numéro choisi. IA simulée, base en mémoire.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
const { createIdentityService, IdentityError } = await import('../services/identity/service.js');
const { createMemoryStore } = await import('../services/identity/store.js');
const { getIdentityConfig } = await import('../services/identity/config.js');
const { decide } = await import('../services/identity/decision.js');
const { fakeJpeg, fakePdf, idExtraction, TEST_KEY } = await import('./identityFixtures.js');

const C = '64b0000000000000000000c1';
const TICKET = { document_type: 'flight_ticket', passenger_names: ['MRS ANNA MARIA ERIKSSON'], travel_dates: ['2026-12-01', '2026-12-15'], legibility: 'good', observations: [] };
const VISA = { document_type: 'visa', holder_given_names_latin: 'ANNA MARIA', holder_last_name_latin: 'ERIKSSON', visa_country_iso2: 'US', schengen: false, valid_from: '2026-11-01', valid_until: '2027-05-01', passport_number: 'L898902C3', legibility: 'good', observations: [] };

let clock; let store; let queue; let declared; let idData; let reads; let saved; let travelRead;
const cfg = () => ({ ...getIdentityConfig({ IDENTITY_FILES_ENC_KEY: TEST_KEY, ANTHROPIC_API_KEY: '' }), enabled: true });
const svc = () => createIdentityService({
  store, config: cfg, now: () => clock, sharp: null, logger: { log() {}, error() {}, warn() {} },
  extract: async (doc) => { reads.push(doc); return doc === 'identity' ? { ok: true, data: idData, usage: { input: 10, output: 10 } } : { ok: false, error: 'invalid_output' }; },
  travelExtract: async (kind) => { reads.push(kind); return travelRead[kind] ?? { ok: true, data: kind === 'ticket' ? TICKET : VISA, usage: { input: 10, output: 10 } }; },
  saveTravel: async (doc) => { saved.push(doc); return doc; },
  loadDeclaration: async () => ({ ...declared }),
  schedule: (fn) => queue.push(fn),
  inbox: { opened() { throw new Error('jamais de revue par l’équipe'); }, decided() {} },
  notify: async () => {},
  journey: () => {},
});
// Le traitement planifié n'est pas attendu par `schedule` : on attend la fin de l'analyse (statut final dans le magasin).
const run = async () => {
  while (queue.length) await queue.shift()();
  for (let i = 0; i < 200 && [...store._verifications.values()].some((v) => v.status === 'processing'); i++) await new Promise((r) => setTimeout(r, 5));
};
beforeEach(() => {
  clock = new Date('2026-11-27T10:00:00Z'); store = createMemoryStore({ now: () => clock }); queue = []; reads = []; saved = []; travelRead = {};
  declared = { fullName: 'Anna Eriksson', residence: 'US', nationality: 'MA' }; idData = idExtraction({ issuing: 'MAR' });
});
async function sendAll(s, kinds = ['passport', 'ticket', 'visa']) {
  for (const kind of kinds) await s.upload(C, 'u1', { kind, docType: 'passport', offer: 'traveler', buffer: kind === 'passport' ? fakeJpeg() : fakePdf() });
}

test('Traveler : passeport + billet + visa, aucun justificatif ; validation automatique ; pays ouvert = pays du numéro', async () => {
  const s = svc();
  await sendAll(s);
  assert.equal((await s.submit({}, C, 'u1')).status, 'processing');
  await run();
  const st = await s.status(C);
  assert.equal(st.status, 'approved'); assert.equal(st.offer, 'traveler'); assert.equal(st.travelerCountry, 'US');
  assert.equal(st.decidedBy, 'auto');
  assert.deepEqual(st.allowedCountries, ['US'], 'pays du numéro Traveler, jamais la nationalité');
  assert.deepEqual(reads, ['identity', 'ticket', 'visa'], 'aucune lecture de justificatif de domicile');
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'approved'); assert.equal(saved[0].numberCountry, 'US'); assert.equal(saved[0].visaRequired, true);
  const v = await s.verifiedCountriesFor(C);
  assert.deepEqual(v.countries, ['US']); assert.equal(v.nationality, 'MA'); assert.equal(v.residence, null);
});

test('Traveler : le justificatif de domicile est refusé à l’envoi ; le billet est refusé hors Traveler', async () => {
  const s = svc();
  await assert.rejects(s.upload(C, 'u1', { kind: 'address_proof', docType: 'passport', offer: 'traveler', buffer: fakePdf() }), (e) => e instanceof IdentityError && e.code === 'FILE_KIND_INVALID');
  await assert.rejects(s.upload(C, 'u1', { kind: 'ticket', docType: 'passport', buffer: fakePdf() }), (e) => e.code === 'FILE_KIND_INVALID');
});

test('Traveler : visa exigé selon la nationalité déclarée ; ressortissant exempté sans visa', async () => {
  const s = svc();
  await sendAll(s, ['passport', 'ticket']);
  await assert.rejects(s.submit({}, C, 'u1'), (e) => e.code === 'FILES_MISSING' && e.extra.missing.includes('visa'));
  declared = { fullName: 'Anna Eriksson', residence: 'US', nationality: 'FR' }; idData = idExtraction({ issuing: 'FRA' });
  assert.equal((await s.submit({}, C, 'u1')).status, 'processing');
  await run();
  assert.equal((await s.status(C)).status, 'approved');
  assert.deepEqual(reads, ['identity', 'ticket'], 'visa non lu pour un ressortissant exempté');
  assert.equal(saved[0].visaRequired, false);
});

test('Traveler : pays du numéro hors US/CA/GB/FR -> déclaration incomplète', async () => {
  const s = svc();
  declared.residence = 'DE';
  await sendAll(s);
  await assert.rejects(s.submit({}, C, 'u1'), (e) => e.code === 'DECLARATION_INCOMPLETE');
});

test('Traveler : billet ou visa non conformes -> refus motivé immédiat, jamais de revue', async () => {
  for (const [kind, data, code] of [['ticket', { ...TICKET, passenger_names: ['JOHN SMITH'] }, 'TICKET_NAME_MISMATCH'], ['visa', { ...VISA, visa_country_iso2: 'CA' }, 'VISA_WRONG_COUNTRY'], ['visa', { ...VISA, passport_number: 'X0000000' }, 'VISA_PASSPORT_MISMATCH']]) {
    store = createMemoryStore({ now: () => clock }); saved = []; travelRead = { [kind]: { ok: true, data } };
    const s = svc();
    await sendAll(s);
    await s.submit({}, C, 'u1'); await run();
    const st = await s.status(C);
    assert.equal(st.status, 'rejected', code); assert.deepEqual(st.reasons, [code]); assert.deepEqual(st.allowedCountries, []);
    assert.equal(saved.length, 0);
    await assert.rejects(s.requestReview(C), (e) => e.code === 'NOTHING_TO_REVIEW', 'aucune demande de revue par l’équipe');
  }
});

test('Traveler : pièce sans MRZ (revue en NOMAD) -> refus motivé, jamais de revue', async () => {
  idData = idExtraction({ issuing: 'MAR', fields: { mrz_lines: [] } });
  const s = svc();
  await sendAll(s);
  await s.submit({}, C, 'u1'); await run();
  const st = await s.status(C);
  assert.equal(st.status, 'rejected'); assert(st.reasons.includes('NO_MRZ'));
});

test('Traveler : lecture du billet indisponible -> refus technique non décompté', async () => {
  travelRead = { ticket: { ok: false, error: 'timeout' } };
  const s = svc();
  await sendAll(s);
  await s.submit({}, C, 'u1'); await run();
  const st = await s.status(C);
  assert.equal(st.status, 'rejected'); assert.deepEqual(st.reasons, ['TRAVEL_CHECK_UNAVAILABLE']);
  assert.equal(st.attemptsLeftTotal, cfg().maxAiAttemptsTotal, 'échec technique non décompté');
});

test('decide({ traveler }) : aucun contrôle de justificatif, passeport exigé', () => {
  const now = new Date('2026-11-27T10:00:00Z');
  const r = decide({ declared: { fullName: 'Anna Eriksson', residence: 'US', nationality: 'MA' }, id: idExtraction({ issuing: 'MAR' }), proof: null, now, traveler: true });
  assert.equal(r.outcome, 'approved');
  assert(!r.checks.some((c) => c.code.startsWith('PROOF') || c.code === 'RESIDENCE'));
  assert.deepEqual(r.idNames, { lastName: 'ERIKSSON', firstName: 'ANNA MARIA' });
  const card = decide({ declared: { fullName: 'Anna Eriksson', residence: 'US', nationality: 'MA' }, id: { ...idExtraction({ issuing: 'MAR' }), document_type: 'id_card' }, proof: null, now, traveler: true });
  assert.equal(card.outcome, 'rejected'); assert(card.reasonCodes.includes('DOCUMENT_TYPE_NOT_ACCEPTED'));
});
