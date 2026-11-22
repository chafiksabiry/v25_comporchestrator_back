import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import ContactTombstone from '../models/ContactTombstone.js';
import { contactProfile } from '../services/contactProfile.js';
import { callerAccess, scopeToCompany, ScopeError } from '../middleware/companyScope.js';
import { loadUserName } from '../services/followUpDirectory.js';
import { canManage, canUse } from '../services/followUps.js';
import {
  LEGACY_CALLING_CODE, MAX_BULK_FILTER, MAX_CALLS_PER_CONTACT, PHONE_SOURCE, displayName, mergeIntoExisting, normalizePhone, parseListQuery,
  phoneUpdate, searchFilter, sortSpec, toContact, tombstoneKeys, validateBulkDelete, validateCallLink, validateCreate, validateLookup,
  validatePatch, validateSyncBatch, withPhoneOrigin,
} from '../services/contacts.js';

const validId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v) && mongoose.Types.ObjectId.isValid(v);
const fail = (res, status, message, code) => res.status(status).json({ success: false, error: message, message, ...(code ? { code } : {}) });
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

/**
 * Indicatif dans lequel lire un numéro national : celui de la ligne Nomad pour une société Nomad, 33 sinon (inchangé).
 * Offre illisible : comportement historique (les autres offres ne doivent pas être bloquées par cette lecture).
 */
async function callingCodeOf(access) {
  try {
    return (await contactProfile(access.companyId)).callingCode;
  } catch (e) {
    console.error('[contacts] profile failed:', e?.message);
    return LEGACY_CALLING_CODE;
  }
}

/**
 * Synchronisation du carnet du téléphone : société Nomad ET son titulaire (preuve positive) seulement. Refus fermé si l'offre
 * ne peut pas être lue. Répond lui-même et renvoie null en cas de refus.
 */
async function syncContext(req, res) {
  const access = await context(req, res);
  if (!access) return null;
  if (access.role !== 'owner' || access.isOwner !== true) { fail(res, 403, 'Seul le titulaire du compte Nomad synchronise ses contacts.', 'CONTACT_SYNC_OWNER_ONLY'); return null; }
  let profile;
  try {
    profile = await contactProfile(access.companyId);
  } catch (e) {
    console.error('[contacts] sync profile failed:', e?.message);
    fail(res, 503, 'Offre de la société illisible.', 'CONTACT_SYNC_PLAN_UNAVAILABLE');
    return null;
  }
  if (!profile.nomad) { fail(res, 403, 'La synchronisation des contacts du téléphone est réservée à l’offre Nomad.', 'CONTACT_SYNC_NOMAD_ONLY'); return null; }
  return { ...access, profile };
}


const scope = (access, extra = {}) => ({ companyId: new mongoose.Types.ObjectId(access.companyId), ...extra });

const BULK_CHUNK = 500;
const chunks = (list, size = BULK_CHUNK) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const duplicateOnly = (e) => e?.code === 11000 || (Array.isArray(e?.writeErrors) && e.writeErrors.length > 0 && e.writeErrors.every((w) => (w?.code ?? w?.err?.code) === 11000));

/**
 * Traces de suppression (contacts du téléphone supprimés dans le portail) pour ces fiches, AVANT de les supprimer : leur propre origine
 * téléphone et chaque contact du téléphone fusionné dedans. Idempotent (upsert sur la clé unique ; une trace déjà posée en parallèle
 * n'est pas une erreur).
 */
async function writeTombstones(companyId, docs) {
  const keys = tombstoneKeys(docs);
  for (const part of chunks(keys)) {
    try {
      await ContactTombstone.bulkWrite(part.map((k) => ({
        updateOne: { filter: { companyId, deviceId: k.deviceId, externalId: k.externalId }, update: { $setOnInsert: { createdAt: new Date() } }, upsert: true },
      })), { ordered: false });
    } catch (e) {
      if (!duplicateOnly(e)) throw e;
    }
  }
  return keys.length;
}

export const contactController = {
  /**
   * GET /contacts?q=&page=&limit=&source=phone&sort=recent|name : recherche libre (nom, société, e-mail, numéro) ou toutes les fiches,
   * paginée (50 par page au plus). Réponse : `contacts`, `total`, `page`, `limit`, `hasMore`.
   */
  async list(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const qy = parseListQuery(req.query);
      const extra = { ...(searchFilter(qy.q, await callingCodeOf(access)) || {}), ...(qy.source ? { source: qy.source } : {}) };
      const filter = scope(access, extra);
      const [docs, total] = await Promise.all([
        Contact.find(filter).sort(sortSpec(qy.sort)).skip((qy.page - 1) * qy.limit).limit(qy.limit),
        Contact.countDocuments(filter),
      ]);
      res.json({ success: true, contacts: docs.map(toContact), total, page: qy.page, limit: qy.limit, hasMore: qy.page * qy.limit < total });
    } catch (e) {
      console.error('[contacts] list failed:', e?.message);
      fail(res, 500, 'Lecture des contacts impossible.');
    }
  },

  /**
   * POST /contacts/lookup { numbers: [] } : nom des contacts pour une liste de numéros (journal d'appels, appel entrant), 200 au plus.
   * Réponse `names` : numéro tel qu'envoyé → `{ id, displayName, fromPhone }` ; un numéro sans fiche est absent.
   */
  async lookup(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const v = validateLookup(req.body, await callingCodeOf(access));
      if (v.error) return fail(res, 400, v.error, v.code);
      const names = {};
      const wanted = [...v.value.keys()];
      if (wanted.length) {
        const docs = await Contact.find(scope(access, { 'phones.number': { $in: wanted } })).sort({ updatedAt: -1 }).limit(wanted.length * 2);
        for (const d of docs) {
          const c = typeof d.toObject === 'function' ? d.toObject() : d;
          for (const p of c.phones || []) {
            for (const raw of v.value.get(p.number) || []) {
              if (!names[raw]) names[raw] = { id: String(c._id), displayName: displayName(c), fromPhone: c.source === PHONE_SOURCE };
            }
          }
        }
      }
      res.json({ success: true, names });
    } catch (e) {
      console.error('[contacts] lookup failed:', e?.message);
      fail(res, 500, 'Lecture des contacts impossible.');
    }
  },

  /** GET /contacts/by-phone?phone= : la fiche qui porte ce numéro (à la réception d'un appel) ; `contact: null` si personne. */
  async byPhone(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      const number = normalizePhone(String(req.query.phone || ''), await callingCodeOf(access));
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
      const v = validateCreate(req.body, { callingCode: await callingCodeOf(access) });
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
      const v = validatePatch(req.body, { callingCode: await callingCodeOf(access) });
      if (v.error) return fail(res, 400, v.error);
      const doc = await Contact.findOne(scope(access, { _id: req.params.id }));
      if (!doc) return fail(res, 404, 'Contact introuvable.');
      if (v.value.phones) {
        const numbers = v.value.phones.map((p) => p.number);
        const clash = numbers.length ? await Contact.findOne(scope(access, { _id: { $ne: doc._id }, 'phones.number': { $in: numbers } })) : null;
        if (clash) return res.status(409).json({ success: false, error: 'contact_exists', message: 'Un autre contact porte déjà ce numéro.', contact: toContact(clash) });
      }
      doc.set(v.value);
      // Modifiée dans le portail : la synchronisation du téléphone ne l'écrasera plus et ne la supprimera jamais.
      if (doc.source === PHONE_SOURCE) doc.editedInPortal = true;
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
      const doc = await Contact.findOne(scope(access, { _id: req.params.id }));
      if (!doc) return fail(res, 404, 'Contact introuvable.');
      // Contact du téléphone supprimé dans le portail (ou fiche dans laquelle des contacts du téléphone ont été fusionnés) : des traces
      // empêchent la synchronisation suivante de les recréer.
      await writeTombstones(doc.companyId, [typeof doc.toObject === 'function' ? doc.toObject() : doc]);
      const r = await Contact.deleteOne(scope(access, { _id: doc._id }));
      if (!r.deletedCount) return fail(res, 404, 'Contact introuvable.');
      res.json({ success: true });
    } catch (e) {
      console.error('[contacts] remove failed:', e?.message);
      fail(res, 500, 'Suppression du contact impossible.');
    }
  },

  /**
   * POST /contacts/bulk-delete : suppression en masse, mêmes droits que la suppression unitaire (titulaire et membres de la société ;
   * un agent ne supprime pas de fiche). Corps : `{ ids: string[] }` (1 à 500) OU `{ filter: { q?, source?: 'phone' }, expectedTotal }`
   * = tous les résultats de ce filtre (mêmes règles que GET /contacts, 5 000 au plus). Filtre : si le nombre réel diffère de
   * `expectedTotal`, rien n'est supprimé (409 `TOTAL_CHANGED` avec le nouveau `total`). Des identifiants d'une autre société ou déjà
   * supprimés sont ignorés sans le révéler. Les traces de suppression sont posées avant. Rien n'est jamais écrit dans le téléphone.
   * Réponse : `{ success, deleted }`.
   */
  async bulkDelete(req, res) {
    try {
      const access = await context(req, res);
      if (!access) return;
      if (!canManage(access)) return fail(res, 403, NOT_ALLOWED);
      const v = validateBulkDelete(req.body);
      if (v.error) return fail(res, 400, v.error, v.code);
      let filter;
      if (v.value.ids) {
        filter = scope(access, { _id: { $in: v.value.ids.map((id) => new mongoose.Types.ObjectId(id)) } });
      } else {
        const { q, source } = v.value;
        filter = scope(access, { ...(searchFilter(q, await callingCodeOf(access)) || {}), ...(source ? { source } : {}) });
      }
      const docs = await Contact.find(filter).select({ _id: 1, source: 1, deviceId: 1, externalId: 1, phoneOrigins: 1 }).limit(MAX_BULK_FILTER + 1).lean();
      if (!v.value.ids) {
        if (docs.length > MAX_BULK_FILTER) {
          const total = await Contact.countDocuments(filter);
          return res.status(400).json({ success: false, error: `${MAX_BULK_FILTER} contacts au plus : précisez la recherche.`, message: `${MAX_BULK_FILTER} contacts au plus : précisez la recherche.`, code: 'CONTACT_BULK_TOO_MANY', total });
        }
        if (docs.length !== v.value.expectedTotal) {
          return res.status(409).json({ success: false, error: 'Le nombre de contacts a changé.', message: 'Le nombre de contacts a changé.', code: 'TOTAL_CHANGED', total: docs.length });
        }
      }
      const companyId = new mongoose.Types.ObjectId(access.companyId);
      const tombstones = await writeTombstones(companyId, docs);
      let deleted = 0;
      for (const part of chunks(docs.map((d) => d._id))) {
        const r = await Contact.deleteMany(scope(access, { _id: { $in: part } }));
        deleted += r?.deletedCount || 0;
      }
      console.log('[contacts] bulk-delete', JSON.stringify({ companyId: String(companyId), userId: String(access.userId || ''), mode: v.value.ids ? 'ids' : 'filter', asked: v.value.ids ? v.value.ids.length : v.value.expectedTotal, deleted, tombstones }));
      res.json({ success: true, deleted });
    } catch (e) {
      console.error('[contacts] bulk-delete failed:', e?.message);
      fail(res, 500, 'Suppression des contacts impossible.');
    }
  },

  /**
   * POST /contacts/sync : un lot (100 contacts au plus) du carnet du téléphone, envoyé par l'app Nomad après l'accord de l'utilisateur.
   * Sens unique téléphone → HARX. Idempotent : un même lot renvoyé donne le même résultat (clé appareil + identifiant du contact).
   * Dédoublonnage par numéro E.164 dans la société : un numéro déjà porté par une autre fiche est fusionné dans celle-ci (champs vides
   * complétés, rien d'écrasé). Dernier lot (`final: true`) : les fiches de cet appareil venues du téléphone, jamais modifiées dans le
   * portail et absentes de ce passage sont supprimées (contact supprimé du téléphone). Aucune suppression si l'app n'a lu aucun contact.
   */
  async sync(req, res) {
    try {
      const access = await syncContext(req, res);
      if (!access) return;
      const v = validateSyncBatch(req.body, { callingCode: access.profile.callingCode });
      if (v.error) return fail(res, 400, v.error, v.code);
      const { deviceId, runId, final, total, contacts, skipped } = v.value;
      const companyId = new mongoose.Types.ObjectId(access.companyId);
      const now = new Date();
      const stats = { created: 0, updated: 0, merged: 0, unchanged: 0, skipped, ignored: 0, deleted: 0 };
      const tomb = contacts.length
        ? new Set((await ContactTombstone.find({ companyId, deviceId, externalId: { $in: contacts.map((c) => c.externalId) } }).lean()).map((t) => t.externalId))
        : new Set();
      for (const c of contacts) {
        if (tomb.has(c.externalId)) { stats.ignored += 1; continue; }
        const mine = await Contact.findOne({ companyId, source: PHONE_SOURCE, deviceId, externalId: c.externalId });
        const numbers = c.phones.map((p) => p.number);
        if (mine) {
          const set = phoneUpdate(mine, c);
          if (set.phones) {
            // Un numéro déjà porté par une AUTRE fiche n'est pas recopié ici (un numéro = une fiche).
            const taken = await Contact.find({ companyId, _id: { $ne: mine._id }, 'phones.number': { $in: numbers } }).lean();
            const held = new Set(taken.flatMap((t) => (t.phones || []).map((p) => p.number)));
            set.phones = set.phones.filter((p) => !held.has(p.number));
            if (set.phones.length) set.phones[0].primary = true;
          }
          mine.set({ ...set, lastSyncRunId: runId, lastSyncedAt: now });
          await mine.save();
          stats[Object.keys(set).length ? 'updated' : 'unchanged'] += 1;
          continue;
        }
        const other = await Contact.findOne({ companyId, 'phones.number': { $in: numbers } });
        if (other) {
          // La fiche se souvient du contact du téléphone fusionné : si on la supprime dans le portail, il ne reviendra pas.
          const origins = withPhoneOrigin(other, deviceId, c.externalId);
          const extra = origins ? { phoneOrigins: origins } : {};
          if (other.source === PHONE_SOURCE && !other.editedInPortal) {
            // Même numéro qu'un autre contact du téléphone : on le garde sur la première fiche, on marque le passage.
            other.set({ lastSyncRunId: runId, lastSyncedAt: now, ...mergeIntoExisting(other, c), ...extra });
          } else {
            other.set({ ...mergeIntoExisting(other, c), ...extra });
          }
          await other.save();
          stats.merged += 1;
          continue;
        }
        await Contact.create({
          companyId, source: PHONE_SOURCE, deviceId, externalId: c.externalId, editedInPortal: false, lastSyncRunId: runId, lastSyncedAt: now,
          firstName: c.firstName, lastName: c.lastName, company: c.company, phones: c.phones, emails: c.emails,
          createdById: access.userId, ownerId: access.userId,
        });
        stats.created += 1;
      }
      if (final && total) {
        const r = await Contact.deleteMany({ companyId, source: PHONE_SOURCE, deviceId, editedInPortal: false, lastSyncRunId: { $ne: runId } });
        stats.deleted = r?.deletedCount || 0;
      }
      res.json({ success: true, ...stats, final, syncedAt: now.toISOString() });
    } catch (e) {
      console.error('[contacts] sync failed:', e?.message);
      fail(res, 500, 'Synchronisation des contacts impossible.', 'CONTACT_SYNC_FAILED');
    }
  },

  /** GET /contacts/sync : état (nombre de fiches venues du téléphone, dernière synchronisation). Nomad seulement. */
  async syncStatus(req, res) {
    try {
      const access = await syncContext(req, res);
      if (!access) return;
      const companyId = new mongoose.Types.ObjectId(access.companyId);
      const [count, last] = await Promise.all([
        Contact.countDocuments({ companyId, source: PHONE_SOURCE }),
        Contact.findOne({ companyId, source: PHONE_SOURCE, lastSyncedAt: { $ne: null } }).sort({ lastSyncedAt: -1 }).lean(),
      ]);
      res.json({ success: true, count, lastSyncedAt: last?.lastSyncedAt ? new Date(last.lastSyncedAt).toISOString() : null, lineCountry: access.profile.lineCountry });
    } catch (e) {
      console.error('[contacts] sync status failed:', e?.message);
      fail(res, 500, 'Lecture de la synchronisation impossible.');
    }
  },

  /**
   * DELETE /contacts/sync?deviceId= : « Désactiver la synchronisation ». Supprime les fiches venues du téléphone (de cet appareil, ou de
   * tous sans `deviceId`) jamais modifiées dans le portail, et efface les traces de suppression. Les fiches modifiées dans le portail restent.
   */
  async disableSync(req, res) {
    try {
      const access = await syncContext(req, res);
      if (!access) return;
      const companyId = new mongoose.Types.ObjectId(access.companyId);
      const deviceId = typeof req.query.deviceId === 'string' && /^[A-Za-z0-9._:-]{8,100}$/.test(req.query.deviceId) ? req.query.deviceId : '';
      const which = { companyId, ...(deviceId ? { deviceId } : {}) };
      const r = await Contact.deleteMany({ ...which, source: PHONE_SOURCE, editedInPortal: false });
      await ContactTombstone.deleteMany(which);
      const kept = await Contact.countDocuments({ ...which, source: PHONE_SOURCE });
      res.json({ success: true, deleted: r?.deletedCount || 0, kept });
    } catch (e) {
      console.error('[contacts] disable sync failed:', e?.message);
      fail(res, 500, 'Désactivation impossible.');
    }
  },
};
