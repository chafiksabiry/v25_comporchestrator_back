import mongoose from 'mongoose';
import ReceptionDirectory from '../models/ReceptionDirectory.js';
import { matchesNumber } from './receptionExtras.js';
import { phrasesFor, sayVoice } from './companyLanguage.js';

/**
 * Appelants bloqués (liste de l'entreprise, gérée par le titulaire et les responsables) : l'appel entrant est refusé poliment.
 * Ajout minimal et isolé dans `inbound-call` : en cas de doute ou d'erreur (base indisponible, numéro masqué, liste vide), renvoie null
 * et le comportement habituel s'applique. Seuls les numéros E.164 de la liste sont comparés (jamais de correspondance approximative).
 * BLOCKED_CALL_MODE=reject : refus silencieux (<Reject/>) au lieu du message court.
 */
/** Sans connexion à la base (ou si elle tarde), on ne bloque personne : le webhook de Twilio ne doit jamais attendre ce contrôle. */
const defaultLoad = (companyId) => (mongoose.connection.readyState !== 1 ? null : Promise.race([query(companyId), new Promise((resolve) => setTimeout(() => resolve(null), 1500).unref?.())]));
const query = (companyId) => ReceptionDirectory.findOne({ companyId: new mongoose.Types.ObjectId(String(companyId)) }).select('blockedNumbers').lean();

/** @returns {Promise<string|null>} le corps TwiML (sans <Response>) à renvoyer si l'appelant est bloqué, sinon null. Ne lève jamais. */
export async function blockedCallBody(companyId, from, { load = defaultLoad, env = process.env, language = 'fr' } = {}) {
  try {
    if (!companyId || !from || !mongoose.Types.ObjectId.isValid(String(companyId))) return null;
    const doc = await load(companyId);
    if (!matchesNumber(doc?.blockedNumbers, from)) return null;
    if (String(env.BLOCKED_CALL_MODE || '').toLowerCase() === 'reject') return '<Reject reason="rejected"/>';
    const v = sayVoice(language);
    return `<Say language="${v.language}" voice="${v.voice}">${phrasesFor(language).blocked}</Say><Hangup/>`;
  } catch (error) {
    console.error('blockedCallBody:', error?.message);
    return null;
  }
}
