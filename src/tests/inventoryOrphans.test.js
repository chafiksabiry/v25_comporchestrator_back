import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';

const { hasReleasedStatus, existingCompanyIds, heldNumbers } = await import('../services/inventoryHolders.js');
const { phoneNumberService } = await import('../services/phoneNumberService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');

const LIVE_CO = '64b000000000000000000001';
const GONE_CO = '6af1f6ba04be802031a7347a';
const NEW_CO = '64b000000000000000000002';

// --- Statuts terminaux
assert.equal(hasReleasedStatus({ status: 'released' }), true);
assert.equal(hasReleasedStatus({ status: 'Cancelled' }), true);
assert.equal(hasReleasedStatus({ status: 'active', billingStatus: 'terminated' }), true);
assert.equal(hasReleasedStatus({ status: 'active' }), false);
assert.equal(hasReleasedStatus({ status: 'active', billingStatus: 'suspended' }), false);
assert.equal(hasReleasedStatus({ status: 'released', billingStatus: 'release_failed' }), false, 'libération à reprendre : retenu');

// --- Recherche des entreprises : une seule requête, garde-fou collection vide, échec = erreur
const fakeDb = (ids, { total = 10, fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    collection: (name) => ({
      find: (filter) => {
        calls.push({ name, filter });
        if (fail) throw new Error('boom');
        return { toArray: async () => filter._id.$in.filter((o) => ids.includes(String(o))).map((o) => ({ _id: o })) };
      },
      estimatedDocumentCount: async () => total,
    }),
  };
};
const db1 = fakeDb([LIVE_CO]);
assert.deepEqual([...(await existingCompanyIds([LIVE_CO, GONE_CO, LIVE_CO, 'bad'], db1))], [LIVE_CO]);
assert.equal(db1.calls.length, 1);
assert.equal(db1.calls[0].name, 'companies');
assert.equal(db1.calls[0].filter._id.$in.length, 2, 'ids dédoublonnés, invalides écartés');
assert.deepEqual([...(await existingCompanyIds([GONE_CO], fakeDb([], { total: 5 })))], []);
await assert.rejects(() => existingCompanyIds([GONE_CO], fakeDb([], { total: 0 })), /empty/);
await assert.rejects(() => existingCompanyIds([LIVE_CO], null), /unavailable/);

// --- Numéros retenus
const docs = [
  { phoneNumber: '+33100000001', companyId: LIVE_CO, status: 'active' },          // entreprise vivante → retenu
  { phoneNumber: '+442081942726', companyId: GONE_CO, status: 'active' },         // entreprise disparue → libre
  { phoneNumber: '+33100000003', companyId: LIVE_CO, status: 'released' },        // ligne libérée → libre
  { phoneNumber: '+33100000004', companyId: null, status: 'active' },             // fiche orpheline → libre
  { phoneNumber: '+33100000005', companyId: LIVE_CO, status: 'active', billingStatus: 'release_failed' }, // retenu
];
assert.deepEqual([...(await heldNumbers(docs, { db: fakeDb([LIVE_CO]) }))].sort(), ['+33100000001', '+33100000005']);
// Base des entreprises illisible : on ne libère rien (sauf les lignes déjà libérées)
assert.deepEqual([...(await heldNumbers(docs, { db: fakeDb([], { fail: true }) }))].sort(), ['+33100000001', '+33100000004', '+33100000005', '+442081942726']);
assert.deepEqual([...(await heldNumbers([{ phoneNumber: '+1', companyId: LIVE_CO, status: 'deleted' }], { lookup: async () => { throw new Error('no call'); } }))], []);

// --- Service : stock et reprise d'un numéro orphelin
const DB = new Map(docs.map((d, i) => [d.phoneNumber, { _id: `id${i}`, updatedAt: new Date(1000 + i), ...d }]));
PhoneNumber.find = (q) => ({ select: () => ({ lean: async () => q.phoneNumber.$in.map((p) => DB.get(p)).filter(Boolean) }) });
PhoneNumber.findOne = (q) => ({ lean: async () => DB.get(q.phoneNumber) || null });
const deleted = [];
const inserted = [];
Object.defineProperty(PhoneNumber, 'collection', {
  configurable: true,
  value: {
    findOneAndDelete: async (filter) => {
      const doc = [...DB.values()].find((d) => d._id === filter._id && +d.updatedAt === +filter.updatedAt);
      if (!doc) return { value: null };
      DB.delete(doc.phoneNumber);
      deleted.push(doc._id);
      return { value: doc };
    },
    insertOne: async (doc) => { inserted.push(doc); DB.set(doc.phoneNumber, doc); },
  },
});
let saveFails = false;
PhoneNumber.prototype.save = async function save() {
  if (saveFails) throw new Error('E11000 duplicate key');
  DB.set(this.phoneNumber, this.toObject());
  return this;
};
// Entreprises : seule LIVE_CO existe
const { default: mongoose } = await import('mongoose');
Object.defineProperty(mongoose.connection, 'db', { configurable: true, get: () => fakeDb([LIVE_CO, NEW_CO]) });

const OWNED = ['+33100000001', '+442081942726', '+33100000003', '+33100000004', '+33100000005', '+33100000009']
  .map((p) => ({ sid: 'PN' + p.slice(-4), phoneNumber: p, capabilities: { voice: true } }));
const created = [];
phoneNumberService.twilioClient = {
  incomingPhoneNumbers: {
    list: async (o = {}) => (o.phoneNumber ? OWNED.filter((n) => n.phoneNumber === o.phoneNumber) : OWNED),
    create: async (o) => { created.push(o); return { sid: 'PNnew', phoneNumber: o.phoneNumber }; },
    remove: async () => { throw new Error('jamais de suppression chez Twilio'); },
  },
};

const free = (await phoneNumberService.unassignedAmong(OWNED)).map((n) => n.phoneNumber).sort();
assert.deepEqual(free, ['+33100000003', '+33100000004', '+33100000009', '+442081942726']);
const gb = await phoneNumberService.listClaimableInventory({ countryCode: 'GB' });
assert.deepEqual(gb.map((n) => n.phoneNumber), ['+442081942726']);

// Reprise : l'ancienne fiche est retirée, la nouvelle créée (pas de conflit d'index), sans achat Twilio
const line = await phoneNumberService.purchaseTwilioNumber('+442081942726', null, undefined, NEW_CO, {});
assert.equal(String(line.companyId), NEW_CO);
assert.equal(line.metadata.previousHolder.companyId, GONE_CO);
assert.equal(line.metadata.previousHolder.phoneNumberId, 'id1');
assert.deepEqual(deleted, ['id1']);
assert.equal(String(DB.get('+442081942726').companyId), NEW_CO);
assert.equal(created.length, 0);

// Désormais détenu par NEW_CO (existante) : plus proposé, rachat refusé
assert.deepEqual(await phoneNumberService.listClaimableInventory({ countryCode: 'GB' }), []);
await assert.rejects(() => phoneNumberService.purchaseTwilioNumber('+442081942726', null, undefined, LIVE_CO, {}), (e) => /not available|pas disponible|NUMBER_NOT_AVAILABLE/i.test(`${e.code} ${e.message}`));

// Fiche modifiée entre la lecture et la reprise : refus, rien supprimé
const racer = DB.get('+33100000003');
const origFindOne = PhoneNumber.findOne;
PhoneNumber.findOne = (q) => ({ lean: async () => (q.phoneNumber === '+33100000003' ? { ...racer, updatedAt: new Date(1) } : DB.get(q.phoneNumber) || null) });
await assert.rejects(() => phoneNumberService.takeOverStaleHolder('+33100000003'), (e) => e.code === 'NUMBER_NOT_AVAILABLE');
assert.ok(DB.get('+33100000003'));
PhoneNumber.findOne = origFindOne;

// Échec de création après reprise : l'ancienne fiche est remise
saveFails = true;
await assert.rejects(() => phoneNumberService.purchaseTwilioNumber('+33100000004', null, undefined, NEW_CO, {}), /E11000/);
assert.equal(inserted.length, 1);
assert.equal(inserted[0]._id, 'id3');
assert.equal(DB.get('+33100000004')._id, 'id3');
saveFails = false;

// Numéro libre sans fiche : création simple, aucune suppression
const before = deleted.length;
await phoneNumberService.purchaseTwilioNumber('+33100000009', null, undefined, NEW_CO, {});
assert.equal(deleted.length, before);
assert.equal(created.length, 0);

console.log('inventoryOrphans.test OK');
process.exit(0);
