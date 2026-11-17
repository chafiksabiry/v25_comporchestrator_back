import mongoose from 'mongoose';
import Note from '../models/Note.js';
import Contact from '../models/Contact.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { companyVisibilityEnabled, listFilter, MAX_NOTES_PER_USER, parseListQuery, toNote, validateCreate, validatePatch } from '../services/notes.js';

/**
 * Notes rapides (post-it). Règles de confidentialité :
 *  - un utilisateur ne lit, ne modifie et ne supprime que SES notes (jamais celles d'une autre société) ; aucun rôle ne lève cette règle ;
 *  - les notes « société » des collègues ne sont lisibles (lecture seule) que si NOTES_COMPANY_VISIBILITY_ENABLED=true ;
 *  - le contenu d'une note n'est JAMAIS journalisé (les journaux ne portent que le nom de l'erreur, pas son message : celui d'une
 *    erreur de validation mongoose cite la valeur saisie) et n'est envoyé à aucune IA.
 */
const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const fail = (res, status, code, message, extra = {}) => res.status(status).json({ success: false, error: message, message, code, ...extra });

/** Appelant + société de la requête. Répond lui-même et renvoie null en cas de refus. */
async function context(req, res) {
  try {
    const access = await callerAccess(req);
    if (!access.companyId) { fail(res, 403, 'NO_COMPANY', 'Aucun centre rattaché à votre compte.'); return null; }
    const scoped = scopeToCompany(access, req.query?.companyId ?? req.body?.companyId);
    return { userId: scoped.userId, companyId: scoped.companyId };
  } catch (e) {
    if (e instanceof ScopeError) { fail(res, e.status, e.code, e.message); return null; }
    throw e;
  }
}

const logFailure = (action, e) => console.error(`[notes] ${action} failed: ${e?.name || 'Error'}`);

const COMPANY_VISIBILITY_OFF = ['NOTE_COMPANY_VISIBILITY_DISABLED', 'Le partage des notes avec la société n’est pas activé : les notes restent privées.'];

/** Le contact lié doit être une fiche de la société de la note. */
async function contactInCompany(contactId, companyId) {
  return Boolean(await Contact.exists({ _id: contactId, companyId: new mongoose.Types.ObjectId(companyId) }));
}

export const notesController = {
  /** GET /notes?pinned=&callId=&contactId=&contactPhone=&q=&page=&limit= */
  async list(req, res) {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const parsed = parseListQuery(req.query);
      if (parsed.error) return fail(res, 400, parsed.code, parsed.error);
      const f = parsed.value;
      const filter = listFilter({ companyId: new mongoose.Types.ObjectId(ctx.companyId), userId: ctx.userId }, f);
      const total = await Note.countDocuments(filter);
      const docs = await Note.find(filter).sort({ pinned: -1, updatedAt: -1, _id: -1 }).skip((f.page - 1) * f.limit).limit(f.limit).lean();
      res.json({ success: true, notes: docs.map((d) => toNote(d, ctx.userId)), page: f.page, limit: f.limit, total, hasMore: f.page * f.limit < total });
    } catch (e) {
      logFailure('list', e);
      fail(res, 500, 'NOTES_READ_FAILED', 'Lecture des notes impossible.');
    }
  },

  /** POST /notes */
  async create(req, res) {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      const parsed = validateCreate(req.body || {});
      if (parsed.error) return fail(res, 400, parsed.code, parsed.error);
      const v = parsed.value;
      if (v.visibility === 'company' && !companyVisibilityEnabled()) return fail(res, 403, ...COMPANY_VISIBILITY_OFF);
      if (v.contactId && !(await contactInCompany(v.contactId, ctx.companyId))) return fail(res, 400, 'NOTE_CONTACT_NOT_FOUND', 'Ce contact n’existe pas dans votre société.');
      const companyOid = new mongoose.Types.ObjectId(ctx.companyId);
      // Quota individuel. Le contrôle n'est pas atomique : deux créations simultanées au plafond peuvent le dépasser d'une note, sans conséquence.
      if ((await Note.countDocuments({ companyId: companyOid, ownerUserId: ctx.userId })) >= MAX_NOTES_PER_USER) {
        return fail(res, 409, 'NOTES_QUOTA_EXCEEDED', `Vous avez atteint la limite de ${MAX_NOTES_PER_USER} notes : supprimez-en avant d’en créer une nouvelle.`, { limit: MAX_NOTES_PER_USER });
      }
      const doc = await Note.create({ ...v, companyId: companyOid, ownerUserId: ctx.userId });
      res.status(201).json({ success: true, note: toNote(doc, ctx.userId) });
    } catch (e) {
      logFailure('create', e);
      fail(res, 500, 'NOTE_CREATE_FAILED', 'Création de la note impossible.');
    }
  },

  /** PATCH /notes/:id : seulement ses propres notes ; une note d'un autre ou d'une autre société est « introuvable ». */
  async patch(req, res) {
    try {
      if (!validId(req.params.id)) return fail(res, 400, 'NOTE_ID_INVALID', 'Identifiant de note invalide.');
      const ctx = await context(req, res);
      if (!ctx) return;
      const parsed = validatePatch(req.body || {});
      if (parsed.error) return fail(res, 400, parsed.code, parsed.error);
      const set = parsed.value;
      if (set.visibility === 'company' && !companyVisibilityEnabled()) return fail(res, 403, ...COMPANY_VISIBILITY_OFF);
      if (set.contactId && !(await contactInCompany(set.contactId, ctx.companyId))) return fail(res, 400, 'NOTE_CONTACT_NOT_FOUND', 'Ce contact n’existe pas dans votre société.');
      const doc = await Note.findOneAndUpdate(
        { _id: req.params.id, companyId: new mongoose.Types.ObjectId(ctx.companyId), ownerUserId: ctx.userId },
        { $set: set },
        { new: true, runValidators: true }
      ).lean();
      if (!doc) return fail(res, 404, 'NOTE_NOT_FOUND', 'Note introuvable.');
      res.json({ success: true, note: toNote(doc, ctx.userId) });
    } catch (e) {
      logFailure('patch', e);
      fail(res, 500, 'NOTE_UPDATE_FAILED', 'Modification de la note impossible.');
    }
  },

  /** DELETE /notes/:id : suppression définitive de sa propre note. */
  async remove(req, res) {
    try {
      if (!validId(req.params.id)) return fail(res, 400, 'NOTE_ID_INVALID', 'Identifiant de note invalide.');
      const ctx = await context(req, res);
      if (!ctx) return;
      const r = await Note.deleteOne({ _id: req.params.id, companyId: new mongoose.Types.ObjectId(ctx.companyId), ownerUserId: ctx.userId });
      if (!r.deletedCount) return fail(res, 404, 'NOTE_NOT_FOUND', 'Note introuvable.');
      res.json({ success: true });
    } catch (e) {
      logFailure('remove', e);
      fail(res, 500, 'NOTE_DELETE_FAILED', 'Suppression de la note impossible.');
    }
  },
};
