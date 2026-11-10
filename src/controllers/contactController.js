import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadUserName } from '../services/followUpDirectory.js';
import { canManage, canUse } from '../services/followUps.js';
import { MAX_CALLS_PER_CONTACT, normalizePhone, searchFilter, toContact, validateCallLink, validateCreate, validatePatch } from '../services/contacts.js';

const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Vous n’avez pas accès aux contacts.';

/** Droits de l'appelant + sa société (même règle que les éléments de suivi). Répond lui-même et renvoie null en cas de refus. */
async function context(req, res) {
  let access;
  try {
    access = await callerAccess(req);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!access.companyId) { fail(res, 403, 'Aucun centre rattaché à votre compte.'); return null; }
  try {
    access = scopeToCompany(access, req.query?.companyId ?? req.body?.companyId);
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.message); return null; }
    throw e;
  }
  if (!canUse(access)) { fail(res, 403, NOT_ALLOWED); return null; }
  return access;
}

const scope = (access, extra = {}) => ({ companyId: new mongoose.Types.ObjectId(access.companyId), ...extra });
const MAX_LIST = 50;

export const contactController = {
  /** GET /contacts?q=&limit= : recherche libre (nom, société, e-mail, numéro) ou, sans texte, les fiches les plus récentes. */
  async list(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), MAX_LIST);
      const filter = scope(access, searchFilter(req.query.q) || {});
      const docs = await Contact.find(filter).sort({ updatedAt: -1 }).limit(limit);
      res.json({ success: true, contacts: docs.map(toContact) });
    } catch (e) {
      console.error('[contacts] list failed:', e?.message);
      fail(res, 500, 'Lecture des contacts impossible.');
    }
  },

  /** GET /contacts/by-phone?phone= : la fiche qui porte ce numéro (à la réception d'un appel) ; `contact: null` si personne. */
  async byPhone(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const number = normalizePhone(String(req.query.phone || ''));
      if (!number) return res.json({ success: true, contact: null });
      const doc = await Contact.findOne(scope(access, { 'phones.number': number })).sort({ updatedAt: -1 });
      res.json({ success: true, contact: doc ? toContact(doc) : null });
    } catch (e) {
      console.error('[contacts] by-phone failed:', e?.message);
      fail(res, 500, 'Lecture du contact impossible.');
    }
  },

  async create(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const v = validateCreate(req.body);
      if (v.error) return fail(res, 400, v.error);
      // Un numéro appartient à une seule fiche du centre : on renvoie la fiche existante plutôt que de la dupliquer.
      const numbers = (v.value.phones || []).map((p) => p.number);
      if (numbers.length) {
        const existing = await Contact.findOne(scope(access, { 'phones.number': { $in: numbers } }));
        if (existing) return res.status(409).json({ success: false, error: 'contact_exists', message: 'Un contact porte déjà ce numéro.', contact: toContact(existing) });
      }
      const name = (await loadUserName(access.userId)) || '';
      const doc = await Contact.create({ ...v.value, companyId: access.companyId, createdById: access.userId, createdByName: name, ownerId: access.userId, ownerName: name });
      res.status(201).json({ success: true, contact: toContact(doc) });
    } catch (e) {
      console.error('[contacts] create failed:', e?.message);
      fail(res, 500, 'Création du contact impossible.');
    }
  },

  async patch(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!validId(req.params.id)) return fail(res, 400, 'Identifiant invalide.');
      const v = validatePatch(req.body);
      if (v.error) return fail(res, 400, v.error);
      const doc = await Contact.findOne(scope(access, { _id: req.params.id }));
      if (!doc) return fail(res, 404, 'Contact introuvable.');
      if (v.value.phones) {
        const numbers = v.value.phones.map((p) => p.number);
        const clash = numbers.length ? await Contact.findOne(scope(access, { _id: { $ne: doc._id }, 'phones.number': { $in: numbers } })) : null;
        if (clash) return res.status(409).json({ success: false, error: 'contact_exists', message: 'Un autre contact porte déjà ce numéro.', contact: toContact(clash) });
      }
      doc.set(v.value);
      await doc.save();
      res.json({ success: true, contact: toContact(doc) });
    } catch (e) {
      console.error('[contacts] patch failed:', e?.message);
      fail(res, 500, 'Modification du contact impossible.');
    }
  },

  /** POST /contacts/:id/calls : associe un appel (identifiant Twilio) à la fiche ; sans doublon. */
  async linkCall(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!validId(req.params.id)) return fail(res, 400, 'Identifiant invalide.');
      const v = validateCallLink(req.body);
      if (v.error) return fail(res, 400, v.error);
      const doc = await Contact.findOne(scope(access, { _id: req.params.id }));
      if (!doc) return fail(res, 404, 'Contact introuvable.');
      if (!doc.calls.some((c) => c.sid === v.value.sid)) {
        doc.calls.push({ ...v.value, at: new Date(), byId: access.userId, byName: (await loadUserName(access.userId)) || '' });
        if (doc.calls.length > MAX_CALLS_PER_CONTACT) doc.calls = doc.calls.slice(-MAX_CALLS_PER_CONTACT);
        doc.callsCount = (doc.callsCount || 0) + 1;
        doc.lastCallAt = new Date();
        await doc.save();
      }
      res.json({ success: true, contact: toContact(doc) });
    } catch (e) {
      console.error('[contacts] link-call failed:', e?.message);
      fail(res, 500, 'Association de l’appel impossible.');
    }
  },

  /** DELETE /contacts/:id : titulaire et membres ; un agent ne supprime pas de fiche. */
  async remove(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_ALLOWED);
      if (!validId(req.params.id)) return fail(res, 400, 'Identifiant invalide.');
      const r = await Contact.deleteOne(scope(access, { _id: req.params.id }));
      if (!r.deletedCount) return fail(res, 404, 'Contact introuvable.');
      res.json({ success: true });
    } catch (e) {
      console.error('[contacts] remove failed:', e?.message);
      fail(res, 500, 'Suppression du contact impossible.');
    }
  },
};
