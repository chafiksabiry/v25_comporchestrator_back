import mongoose from 'mongoose';

/**
 * Parcours d'inscription d'un compte (fondateur, 25/11/2026 : « il faut suivre surtout les parcours d'inscription et les noter »).
 * Les étapes datées sont écrites sur le compte (`users.journey`, collection partagée avec v25_registration_backend, qui définit le
 * modèle et pose la création du compte et les vérifications : src/utils/signupJourney.js). Ce service pose les étapes qui ont lieu
 * ici : identité envoyée / vérifiée, offre choisie (NOMAD), appel d'essai, numéro choisi, paiement réussi.
 *
 * Règles (identiques des deux côtés) :
 *  - chaque étape est posée la PREMIÈRE fois seulement (`$exists: false`) : rejouer un événement ne change jamais la date ;
 *  - seulement sur un compte dont le parcours est enregistré (`journey.account_created`) : les comptes antérieurs ne sont pas rattrapés ;
 *  - jamais bloquant : l'écriture n'est pas attendue par le parcours du client et une erreur est seulement journalisée ;
 *  - aucune donnée personnelle : une date (et l'issue de l'appel d'essai, valeur d'une liste fermée).
 */
export const JOURNEY_MILESTONES = Object.freeze([
  'account_created',
  'email_verified',
  'phone_verified',
  'identity_submitted',
  'identity_verified',
  'offer_chosen',
  'trial_call',
  'number_chosen',
  'payment_succeeded',
  'onboarding_finished',
  'first_login_app',
]);
export const TRIAL_CALL_OUTCOMES = Object.freeze(['done', 'skipped', 'used']);

const isId = (v) => Boolean(v) && mongoose.Types.ObjectId.isValid(String(v)) && /^[a-f\d]{24}$/i.test(String(v));

/**
 * Mise à jour conditionnelle d'une étape (pure). `onlyOffer` : ne poser que si le parcours d'entrée est cette offre
 * (appel d'essai « sauté » : NOMAD seulement).
 * @returns {{ filter: object, update: object } | null}
 */
export function journeyStampUpdate(userId, milestone, { at = new Date(), outcome = null, onlyOffer = null } = {}) {
  if (!JOURNEY_MILESTONES.includes(milestone) || milestone === 'account_created') return null;
  if (milestone === 'trial_call' && !TRIAL_CALL_OUTCOMES.includes(outcome)) return null;
  const set = { [`journey.${milestone}`]: at };
  if (milestone === 'trial_call') set['journey.trial_call_outcome'] = outcome;
  return {
    filter: {
      _id: userId,
      'journey.account_created': { $exists: true },
      [`journey.${milestone}`]: { $exists: false },
      ...(onlyOffer ? { 'signup.offer': onlyOffer } : {}),
    },
    update: { $set: set },
  };
}

const defaultDb = () => mongoose.connection.db;

/**
 * Pose une étape pour un compte (`userId`) ou, à défaut, pour le titulaire de la société (`companies.userId`).
 * Ne lève jamais d'erreur.
 * @returns {Promise<boolean>} true si l'étape vient d'être posée
 */
export async function stampJourney({ userId = null, companyId = null } = {}, milestone, { db = defaultDb(), logger = console, ...opts } = {}) {
  try {
    if (!db || typeof db.collection !== 'function') return false;
    let uid = isId(userId) ? String(userId) : null;
    if (!uid && isId(companyId)) {
      const company = await db.collection('companies').findOne({ _id: new mongoose.Types.ObjectId(String(companyId)) }, { projection: { userId: 1 } });
      uid = isId(company?.userId) ? String(company.userId) : null;
    }
    if (!uid) return false;
    const op = journeyStampUpdate(new mongoose.Types.ObjectId(uid), milestone, opts);
    if (!op) return false;
    const r = await db.collection('users').updateOne(op.filter, op.update);
    return r?.modifiedCount === 1;
  } catch (err) {
    logger.warn?.(`[journey] étape ${milestone} non posée :`, err?.message || err);
    return false;
  }
}

/** Même chose sans attendre (appel « tire et oublie » depuis un parcours client ou un webhook). */
export function stampJourneyLater(who, milestone, opts) {
  Promise.resolve()
    .then(() => stampJourney(who, milestone, opts))
    .catch(() => undefined);
}

/**
 * Paiement d'abonnement réussi : étape `payment_succeeded`, et pour un parcours NOMAD sans appel d'essai, `trial_call` « sauté »
 * (paiement possible sans essai : essai impossible dans le pays, ou choix de la personne).
 */
export async function stampPaymentSucceeded(who, opts = {}) {
  const at = opts.at || new Date();
  const paid = await stampJourney(who, 'payment_succeeded', { ...opts, at });
  await stampJourney(who, 'trial_call', { ...opts, at, outcome: 'skipped', onlyOffer: 'nomad' });
  return paid;
}
