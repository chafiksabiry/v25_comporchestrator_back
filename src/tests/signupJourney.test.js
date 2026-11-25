import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { journeyStampUpdate, stampJourney, stampPaymentSucceeded, JOURNEY_MILESTONES } from '../services/signupJourney.js';
import { createTrialCallController } from '../controllers/trialCallController.js';
import { createIdentityService } from '../services/identity/service.js';

/** Base en mémoire : `users` (filtre conditionnel $exists / égalité, comme MongoDB) et `companies` (titulaire). */
function memoryDb({ users = [], companies = [] } = {}) {
  const get = (doc, path) => path.split('.').reduce((v, k) => v?.[k], doc);
  const matches = (doc, filter) => Object.entries(filter).every(([k, cond]) => {
    if (k === '_id') return String(doc._id) === String(cond);
    if (cond && typeof cond === 'object' && '$exists' in cond) return (get(doc, k) !== undefined) === cond.$exists;
    return get(doc, k) === cond;
  });
  return {
    users,
    collection: (name) => ({
      findOne: async (filter) => (name === 'companies' ? companies : users).find((d) => matches(d, filter)) || null,
      updateOne: async (filter, update) => {
        const doc = users.find((d) => matches(d, filter));
        if (!doc) return { modifiedCount: 0 };
        for (const [path, v] of Object.entries(update.$set)) {
          const keys = path.split('.');
          let o = doc;
          for (const k of keys.slice(0, -1)) o = o[k] ??= {};
          o[keys.at(-1)] = v;
        }
        return { modifiedCount: 1 };
      },
    }),
  };
}

const T0 = new Date('2026-11-25T09:00:00Z');
const T1 = new Date('2026-11-25T09:30:00Z');
const T2 = new Date('2026-11-25T10:00:00Z');

test('mêmes étapes que v25_registration_backend ; filtre conditionnel', () => {
  assert.deepEqual(JOURNEY_MILESTONES, [
    'account_created', 'email_verified', 'phone_verified', 'identity_submitted', 'identity_verified', 'offer_chosen',
    'trial_call', 'number_chosen', 'payment_succeeded', 'onboarding_finished', 'first_login_app',
  ]);
  const id = new mongoose.Types.ObjectId();
  assert.deepEqual(journeyStampUpdate(id, 'identity_verified', { at: T1 }), {
    filter: { _id: id, 'journey.account_created': { $exists: true }, 'journey.identity_verified': { $exists: false } },
    update: { $set: { 'journey.identity_verified': T1 } },
  });
  assert.equal(journeyStampUpdate(id, 'account_created'), null);
  assert.equal(journeyStampUpdate(id, 'trial_call'), null);
  assert.equal(journeyStampUpdate(id, 'trial_call', { outcome: 'maybe' }), null);
  assert.equal(journeyStampUpdate(id, 'autre'), null);
});

test('stampJourney : première fois seulement, compte au parcours enregistré, titulaire de la société, jamais d’erreur', async () => {
  const u = new mongoose.Types.ObjectId();
  const old = new mongoose.Types.ObjectId();
  const c = new mongoose.Types.ObjectId();
  const db = memoryDb({ users: [{ _id: u, journey: { account_created: T0 } }, { _id: old }], companies: [{ _id: c, userId: u }] });
  assert.equal(await stampJourney({ userId: String(u) }, 'identity_submitted', { db, at: T1 }), true);
  assert.equal(await stampJourney({ userId: String(u) }, 'identity_submitted', { db, at: T2 }), false, 'rejoué : date inchangée');
  assert.equal(db.users[0].journey.identity_submitted, T1);
  assert.equal(await stampJourney({ companyId: String(c) }, 'number_chosen', { db, at: T1 }), true, 'titulaire de la société');
  assert.equal(db.users[0].journey.number_chosen, T1);
  assert.equal(await stampJourney({ userId: String(old) }, 'identity_submitted', { db }), false, 'compte antérieur : rien');
  assert.equal(db.users[1].journey, undefined);
  assert.equal(await stampJourney({ companyId: String(new mongoose.Types.ObjectId()) }, 'number_chosen', { db }), false);
  assert.equal(await stampJourney({ userId: 'pas-un-id' }, 'number_chosen', { db }), false);
  assert.equal(await stampJourney({ userId: String(u) }, 'number_chosen', { db: null }), false, 'sans base : rien, sans erreur');
  const failing = { collection: () => ({ updateOne: async () => { throw new Error('panne'); } }) };
  assert.equal(await stampJourney({ userId: String(u) }, 'payment_succeeded', { db: failing, logger: { warn: () => {} } }), false);
});

test('paiement : payment_succeeded, et appel d’essai « sauté » pour NOMAD seulement (jamais par-dessus un essai passé)', async () => {
  const nomad = new mongoose.Types.ObjectId();
  const tried = new mongoose.Types.ObjectId();
  const cloud = new mongoose.Types.ObjectId();
  const db = memoryDb({ users: [
    { _id: nomad, signup: { offer: 'nomad' }, journey: { account_created: T0 } },
    { _id: tried, signup: { offer: 'nomad' }, journey: { account_created: T0, trial_call: T1, trial_call_outcome: 'done' } },
    { _id: cloud, signup: { offer: 'cloud' }, journey: { account_created: T0 } },
  ] });
  assert.equal(await stampPaymentSucceeded({ userId: String(nomad) }, { db, at: T2 }), true);
  assert.deepEqual([db.users[0].journey.payment_succeeded, db.users[0].journey.trial_call_outcome], [T2, 'skipped']);
  await stampPaymentSucceeded({ userId: String(tried) }, { db, at: T2 });
  assert.deepEqual([db.users[1].journey.trial_call, db.users[1].journey.trial_call_outcome], [T1, 'done']);
  await stampPaymentSucceeded({ userId: String(cloud) }, { db, at: T2 });
  assert.equal(db.users[2].journey.payment_succeeded, T2);
  assert.equal(db.users[2].journey.trial_call, undefined, 'CLOUD : pas d’appel d’essai NOMAD');
  assert.equal(await stampPaymentSucceeded({ userId: String(nomad) }, { db, at: new Date() }), false, 'rejoué');
  assert.equal(db.users[0].journey.payment_succeeded, T2);
});

test('appel d’essai : « Choisir » pose offer_chosen même mesure désactivée, la réponse ne change pas', async () => {
  const calls = [];
  const c = createTrialCallController({
    store: { recordEvent: async () => {} },
    env: {},
    journey: (who, milestone, opts) => calls.push([who, milestone, opts]),
  });
  const res = { statusCode: 0, status(code) { this.statusCode = code; return this; }, end() { return this; }, json() { return this; } };
  await c.events({ user: { userId: 'u1' }, body: { name: 'choose_clicked' } }, res);
  assert.equal(res.statusCode, 204);
  assert.deepEqual(calls, [[{ userId: 'u1' }, 'offer_chosen', undefined]]);
  calls.length = 0;
  await c.events({ user: { userId: 'u1' }, body: { name: 'offer_viewed' } }, res);
  await c.events({ body: { name: 'choose_clicked' } }, res);
  assert.deepEqual(calls, []);
});

test('identité : validation par l’équipe -> identity_verified (compte du dossier, société en appoint)', async () => {
  const calls = [];
  const v = { _id: 'v1', companyId: 'c1', userId: 'u1', status: 'review', declared: { residence: 'FR', nationality: 'MA' } };
  const store = {
    getVerification: async () => v,
    updateVerification: async (_id, patch) => ({ ...v, ...patch }),
    deleteFilesOf: async () => {},
    supersedeOthers: async () => {},
  };
  const svc = createIdentityService({
    store,
    inbox: { opened: async () => {}, decided: async () => {} },
    notify: async () => {},
    journey: (who, milestone) => calls.push([who, milestone]),
    logger: { warn: () => {}, log: () => {}, error: () => {} },
  });
  await svc.adminDecide('v1', 'admin1', { outcome: 'approved', residence: 'FR' });
  assert.deepEqual(calls, [[{ userId: 'u1', companyId: 'c1' }, 'identity_verified']]);
  calls.length = 0;
  await svc.adminDecide('v1', 'admin1', { outcome: 'resubmit' });
  assert.deepEqual(calls, [], 'refus / renvoi : aucune étape');
});
