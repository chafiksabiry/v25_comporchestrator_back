import mongoose from 'mongoose';
import InboundEmail from '../models/InboundEmail.js';
import FollowUpItem from '../models/FollowUpItem.js';
import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatSharedAccount from '../models/SecretariatSharedAccount.js';
import SecretariatTools from '../models/SecretariatTools.js';
import { MAILBOX_PROVIDERS, messages, withConnection } from './secretariatConnections.js';
import { purgeInboundEmails, purgePersonalInbox } from './inboundEmailStore.js';
import { loadTools, mergedTools } from './secretariatTools.js';
import { hasReadScope, hasWriteScope, SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';

/**
 * E-mails ENTRANTS autorisés puis traités. Source = la messagerie connectée du centre (Gmail / Outlook) avec le scope OPTIONNEL de lecture.
 * Garde-fous : aucune lecture chez le fournisseur sans `inbound.enabled` ET sans scope de lecture ; seules des MÉTADONNÉES sont stockées
 * (modèle InboundEmail, TTL 30 jours) ; le corps est relu en direct à la demande, jamais stocké ni journalisé ; isolation stricte par centre.
 * Les appels aux fournisseurs (Gmail messages.list/get, Graph /me/mailFolders/inbox/messages) sont À VÉRIFIER en recette avec un vrai compte.
 *
 * DEUX PORTÉES, mêmes règles :
 *  - ENTREPRISE (premier argument = identifiant de société, chaîne) : e-mails de la boîte du centre, `ownerUserId` et `accountId` nuls ;
 *  - PERSONNELLE (`mineScope(société, utilisateur, compte)`) : e-mails de la messagerie PERSONNELLE d'une secrétaire (SecretariatSharedAccount.personalUserId),
 *    lisibles par elle SEULE. Le compte est TOUJOURS rechargé avec société + propriétaire (`loadMine`) : toute autre personne, un autre compte ou une autre
 *    société obtient « introuvable ». Consentement de lecture séparé et optionnel (`inbound.readEnabled` + scope), indépendant du réglage `inbound.enabled`
 *    de l'entreprise ; AUCUN scope d'écriture : suppression / archivage = application seulement (`mailbox: 'app_only'`). Chaque requête filtre la portée.
 */
export const PAGE_SIZE = 25;
export const REFRESH_MIN_INTERVAL_MS = 30_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const OID_RE = /^[0-9a-fA-F]{24}$/;
export const isId = (v) => typeof v === 'string' && OID_RE.test(v);

/** Portée PERSONNELLE : les trois identifiants viennent de la SESSION (jamais du corps de requête). */
export const mineScope = (companyId, userId, accountId) => ({ companyId: String(companyId), userId: String(userId), accountId: String(accountId) });
const asScope = (s) => (s && typeof s === 'object' ? s : { companyId: String(s), userId: null, accountId: null });
const isMine = (s) => Boolean(s.userId);
/** Filtre de portée de TOUTE requête sur les e-mails stockés : l'entreprise ne voit jamais un e-mail personnel, et inversement. */
const scopeFilter = (s) => (isMine(s)
  ? { companyId: oid(s.companyId), ownerUserId: String(s.userId), accountId: oid(s.accountId) }
  : { companyId: oid(s.companyId), ownerUserId: null, accountId: null });
const connOpts = (s) => (isMine(s) ? { accountId: String(s.accountId) } : {});
const connect = (s, provider, fn) => withConnection(s.companyId, provider, fn, connOpts(s));

/**
 * Messagerie personnelle de la secrétaire : rechargée avec société ET propriétaire. Inconnue, d'une autre personne ou d'une autre société : not_found.
 * @returns {Promise<{_id: any, provider: string, accountEmail: string, status: string, scopes: string[], inbound?: {readEnabled?: boolean, lastSyncAt?: Date|null}}>}
 */
export async function loadMine(s) {
  if (!isMine(s) || !isId(String(s.accountId))) throw new SecretariatError('not_found', MINE_NOT_FOUND);
  const acc = await SecretariatSharedAccount.findOne({ _id: oid(s.accountId), companyId: oid(s.companyId), personalUserId: String(s.userId) }).select('provider accountEmail status scopes inbound').lean();
  if (!acc) throw new SecretariatError('not_found', MINE_NOT_FOUND);
  return acc;
}
export const MINE_NOT_FOUND = 'Messagerie introuvable.';
/** Lecture activée = consentement donné, pas arrêté, ET scope de lecture réellement accordé. */
export const mineReadEnabled = (acc) => acc?.inbound?.readEnabled === true && hasReadScope(acc.provider, acc.scopes);

const attempts = new Map();
/** Remet à zéro la limite de fréquence (tests). */
export const resetRefreshThrottle = () => attempts.clear();

/**
 * Messagerie à lire : parmi les messageries connectées (le fournisseur choisi pour l'envoi s'il est actif, sinon toutes), la première qui a le scope de lecture.
 * @returns {Promise<{mailbox?: {provider: string, account: string}, canRead: boolean, error?: 'no_mailbox'|'needs_reauth'|'read_scope_missing'}>}
 */
export async function locateMailbox(companyId, preferred) {
  const rows = await SecretariatConnection.find({ companyId: oid(companyId), provider: { $in: MAILBOX_PROVIDERS } }).select('provider accountEmail status scopes').lean();
  const active = rows.filter((r) => r.status === 'connected');
  if (!active.length) return { canRead: false, error: rows.some((r) => r.status === 'needs_reauth') ? 'needs_reauth' : 'no_mailbox' };
  const candidates = active.some((r) => r.provider === preferred) ? active.filter((r) => r.provider === preferred) : active;
  const readable = candidates.find((r) => hasReadScope(r.provider, r.scopes));
  if (!readable) return { canRead: false, error: 'read_scope_missing' };
  return { canRead: true, canModify: hasWriteScope(readable.provider, readable.scopes), mailbox: { provider: readable.provider, account: readable.accountEmail } };
}

const ERRORS = {
  inbound_disabled: 'La lecture des e-mails entrants n’est pas activée.',
  no_mailbox: 'Aucune messagerie n’est connectée. Connectez-la dans Paramétrage > Outils.',
  needs_reauth: 'La connexion de la messagerie a expiré ou a été révoquée. Reconnectez-la dans Paramétrage > Outils.',
  read_scope_missing: 'La messagerie connectée n’a pas l’autorisation de lecture. Autorisez la lecture dans Paramétrage > Outils.',
  write_scope_missing: 'La messagerie connectée n’a pas l’autorisation de gérer les e-mails (corbeille, archivage). Donnez cette autorisation dans Paramétrage > Outils.',
  mine_read_scope_missing: 'La lecture de votre messagerie n’est pas activée. Activez-la depuis votre profil.',
};

/**
 * Répercussion dans la vraie messagerie (suppression = MISE À LA CORBEILLE réversible, archivage). Jamais sans `inbound.enabled` ET `inbound.mailboxActions`
 * ET scope d'écriture (`canModify`). Renvoie { sync: false } (application seulement), { sync: true, provider } ; lève write_scope_missing (réglage vrai mais
 * pas d'autorisation d'écriture : rien n'est touché), no_mailbox ou needs_reauth.
 */
async function mailboxSync(scope) {
  const s = asScope(scope);
  if (isMine(s)) return { sync: false }; // messagerie personnelle : AUCUN scope d'écriture, application seulement
  const companyId = s.companyId;
  const tools = mergedTools(await loadTools(companyId));
  if (tools.inbound.enabled !== true || tools.inbound.mailboxActions !== true) return { sync: false };
  const found = await locateMailbox(companyId, tools.email.provider);
  if (found.error === 'no_mailbox' || found.error === 'needs_reauth') throw new SecretariatError(found.error, ERRORS[found.error]);
  if (found.error || !found.canModify) throw new SecretariatError('write_scope_missing', ERRORS.write_scope_missing);
  return { sync: true, provider: found.mailbox.provider };
}

/**
 * Un appel d'écriture chez le fournisseur pour UN e-mail (`op` : 'trash' | 'archive' | 'unarchive'). Renvoie le nouvel identifiant du message s'il a changé
 * (Graph), sinon null. 404 = succès (géré par le fournisseur). Toute autre panne : provider_error (message sûr) ; needs_reauth conservé. Jamais de détail.
 */
async function providerWrite(companyId, provider, doc, op) {
  if (doc.provider !== provider) throw new SecretariatError('no_mailbox', ERRORS.no_mailbox); // la messagerie a changé depuis la lecture
  try {
    const out = await withConnection(companyId, provider, (accessToken, http) => (op === 'trash'
      ? PROVIDERS[provider].trashMessage({ http, accessToken, id: doc.providerMessageId })
      : PROVIDERS[provider].setArchived({ http, accessToken, id: doc.providerMessageId, archived: op === 'archive' })));
    return out?.id || null;
  } catch (error) {
    if (error instanceof SecretariatError && error.code === 'needs_reauth') throw error;
    throw new SecretariatError('provider_error', 'La messagerie est momentanément indisponible. Réessayez dans un instant.');
  }
}

/** Applique `providerWrite` à plusieurs e-mails (5 en parallèle). @returns {Promise<Array<{doc, ok: boolean, newId: string|null}>>} */
async function providerWriteMany(companyId, provider, docs, op) {
  const out = [];
  for (let i = 0; i < docs.length; i += 5) {
    out.push(...await Promise.all(docs.slice(i, i + 5).map(async (doc) => {
      try { return { doc, ok: true, newId: await providerWrite(companyId, provider, doc, op) }; } catch { return { doc, ok: false, newId: null }; }
    })));
  }
  return out;
}

/** Contrôle d'accès à la lecture : lève inbound_disabled | no_mailbox | needs_reauth | read_scope_missing. */
async function requireReadAccess(scope) {
  const s = asScope(scope);
  if (isMine(s)) {
    const acc = await loadMine(s);
    if (acc.status === 'needs_reauth') throw new SecretariatError('needs_reauth', messages.personalNeedsReauth()); // jamais de repli sur un autre compte
    if (!mineReadEnabled(acc)) throw new SecretariatError('read_scope_missing', ERRORS.mine_read_scope_missing);
    return { provider: acc.provider, account: acc.accountEmail, lastSyncAt: acc.inbound?.lastSyncAt };
  }
  const companyId = s.companyId;
  const tools = mergedTools(await loadTools(companyId));
  if (tools.inbound.enabled !== true) throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled);
  const found = await locateMailbox(companyId, tools.email.provider);
  if (found.error) throw new SecretariatError(found.error, ERRORS[found.error]);
  return { ...found.mailbox, lastSyncAt: tools.inbound.lastSyncAt };
}

export const toItem = (d) => ({
  id: String(d._id),
  from: { name: d.fromName || '', email: d.fromEmail || '' },
  subject: d.subject || '',
  receivedAt: new Date(d.receivedAt).toISOString(),
  snippet: String(d.snippet || '').slice(0, 200),
  status: d.status === 'handled' ? 'handled' : 'new',
  archived: Boolean(d.archivedAt),
  followUpIds: (d.followUpIds || []).map(String),
});

export const MAX_BULK_IDS = 100;
const ACTIVE = { deletedAt: null, archivedAt: null };
const ARCHIVED = { deletedAt: null, archivedAt: { $ne: null } };

/**
 * Vue renvoyée par GET et par le rafraîchissement. Ne lit RIEN chez le fournisseur.
 * `view` : 'active' (défaut : ni archivés ni supprimés) | 'archived' (archivés non supprimés). `counts` : new/handled sur les actifs, archived = nombre d'archivés.
 * Portée personnelle : `enabled` = lecture activée par la secrétaire (jamais le réglage de l'entreprise), + `needsReauth` et `email` ; rien n'est listé tant que la lecture n'est pas activée.
 */
export async function inboundView(scope, view = 'active') {
  const s = asScope(scope);
  if (view !== 'active' && view !== 'archived') throw new SecretariatError('invalid_request', 'Vue invalide : « active » ou « archived ».');
  const fil = scopeFilter(s);
  const list = (extra) => InboundEmail.find({ ...fil, ...extra }).sort({ receivedAt: -1 }).limit(PAGE_SIZE).lean();
  const count = (extra) => InboundEmail.countDocuments({ ...fil, ...extra });
  const counted = (enabled) => (enabled
    ? Promise.all([list(view === 'archived' ? ARCHIVED : ACTIVE), count({ ...ACTIVE, status: 'new' }), count({ ...ACTIVE, status: 'handled' }), count(ARCHIVED)])
    : [[], 0, 0, 0]);
  const iso = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
  if (isMine(s)) {
    const acc = await loadMine(s);
    const enabled = acc.inbound?.readEnabled === true;
    const [rows, nw, handled, archived] = await counted(enabled);
    return {
      enabled, canRead: acc.status === 'connected' && mineReadEnabled(acc), needsReauth: acc.status === 'needs_reauth', email: acc.accountEmail, provider: acc.provider,
      lastSyncAt: iso(acc.inbound?.lastSyncAt), counts: { new: nw, handled, archived }, items: rows.map(toItem),
    };
  }
  const tools = mergedTools(await loadTools(s.companyId));
  const enabled = tools.inbound.enabled === true;
  const [located, [rows, nw, handled, archived]] = await Promise.all([locateMailbox(s.companyId, tools.email.provider), counted(enabled)]);
  return { enabled, canRead: located.canRead, lastSyncAt: iso(tools.inbound.lastSyncAt), counts: { new: nw, handled, archived }, items: rows.map(toItem) };
}

/** Rafraîchissement : lit les messages récents chez le fournisseur et n'enregistre que des métadonnées. Au plus un appel fournisseur par portée toutes les 30 s. */
export async function refreshInbound(scope, now = Date.now()) {
  const s = asScope(scope);
  const access = await requireReadAccess(s);
  const key = isMine(s) ? `mine:${s.accountId}` : String(s.companyId);
  const lastSync = access.lastSyncAt ? new Date(access.lastSyncAt).getTime() : 0;
  if (now - Math.max(attempts.get(key) || 0, lastSync) < REFRESH_MIN_INTERVAL_MS) return inboundView(s); // trop tôt : état stocké, aucun appel fournisseur
  attempts.set(key, now);
  const fetched = await connect(s, access.provider, (accessToken, http) => PROVIDERS[access.provider].listInbox({ http, accessToken, limit: PAGE_SIZE }));
  // Désactivée (ou retirée) pendant la lecture : on n'écrit rien. Personnelle : arrêt de la lecture ou déconnexion = plus rien n'est écrit, et le reste est purgé.
  const stillEnabled = async () => {
    if (!isMine(s)) return mergedTools(await loadTools(s.companyId)).inbound.enabled === true;
    try { return (await loadMine(s)).inbound?.readEnabled === true; } catch { return false; }
  };
  const gone = async () => { if (isMine(s)) await purgePersonalInbox(s.companyId, s.userId, s.accountId); else await purgeInboundEmails(s.companyId); };
  const goneError = () => (isMine(s) ? new SecretariatError('read_scope_missing', ERRORS.mine_read_scope_missing) : new SecretariatError('inbound_disabled', ERRORS.inbound_disabled));
  if (!(await stillEnabled())) { if (isMine(s)) await gone(); throw goneError(); }
  const fil = scopeFilter(s);
  for (const m of fetched.slice(0, PAGE_SIZE)) {
    await InboundEmail.updateOne(
      { ...fil, providerMessageId: m.id },
      { $setOnInsert: { provider: access.provider, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, receivedAt: m.receivedAt, snippet: m.snippet, status: 'new', followUpIds: [], fetchedAt: new Date() } },
      { upsert: true }
    );
  }
  if (isMine(s)) await SecretariatSharedAccount.updateOne({ _id: oid(s.accountId), companyId: oid(s.companyId), personalUserId: String(s.userId) }, { $set: { 'inbound.lastSyncAt': new Date(now) } });
  else await SecretariatTools.updateOne({ companyId: oid(s.companyId) }, { $set: { 'inbound.lastSyncAt': new Date(now) } });
  // Désactivée pendant l'écriture : purge (aucun résidu après un « off »).
  if (!(await stillEnabled())) { await gone(); throw goneError(); }
  return inboundView(s);
}

/** Corps d'un message lu EN DIRECT (texte ≤ 20 000 caractères, plus la partie HTML d'origine quand le message en a une). Jamais stocké, jamais journalisé. */
export async function readInboundBody(scope, id) {
  const s = asScope(scope);
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const access = await requireReadAccess(s);
  const doc = await InboundEmail.findOne({ _id: oid(id), ...scopeFilter(s), deletedAt: null }).select('provider providerMessageId').lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  if (doc.provider !== access.provider) throw new SecretariatError('no_mailbox', ERRORS.no_mailbox); // la messagerie a changé depuis la lecture
  const P = PROVIDERS[access.provider];
  const out = await connect(s, access.provider, async (accessToken, http) => (P.readBodyFull
    ? P.readBodyFull({ http, accessToken, id: doc.providerMessageId })
    : { text: await P.readBody({ http, accessToken, id: doc.providerMessageId }) }));
  return out.html ? { text: out.text, html: out.html } : { text: out.text };
}

const plainBody = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

/**
 * Marque « traité » (et rattache, facultatif, un élément « À traiter » du MÊME centre) et/ou archive / désarchive. Fonctionne sans lecture chez le fournisseur.
 * Idempotent. Un e-mail supprimé est introuvable (404). Portée personnelle : toujours dans l'application seulement.
 */
export async function markHandled(scope, id, body) {
  const s = asScope(scope);
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const b = plainBody(body);
  if (b.status === undefined && b.archived === undefined) throw new SecretariatError('invalid_request', 'Indiquez « status » ou « archived ».');
  if (b.status !== undefined && b.status !== 'handled') throw new SecretariatError('invalid_request', 'Seul le statut « handled » est accepté.');
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new SecretariatError('invalid_request', 'Le champ « archived » doit être un booléen.');
  if (b.followUpId !== undefined && b.status === undefined) throw new SecretariatError('invalid_request', 'Un élément à traiter se rattache avec le statut « handled ».');
  if (b.followUpId !== undefined && !isId(b.followUpId)) throw new SecretariatError('invalid_request', 'Identifiant d’élément à traiter invalide.');
  if (b.followUpId !== undefined && !(await FollowUpItem.exists({ _id: oid(b.followUpId), companyId: oid(s.companyId) }))) throw new SecretariatError('invalid_request', 'Élément à traiter introuvable.');
  if (isMine(s)) await loadMine(s); // portée personnelle : propriétaire vérifié avant toute écriture
  const fil = scopeFilter(s);
  const $set = {};
  if (b.status === 'handled') $set.status = 'handled';
  if (b.archived !== undefined) $set.archivedAt = b.archived ? new Date() : null;
  // Archivage répercuté dans la messagerie (réglage + autorisation d'écriture ; jamais en portée personnelle) : appel fournisseur AVANT la mise à jour locale.
  let mailbox = 'app_only';
  if (b.archived !== undefined) {
    const current = await InboundEmail.findOne({ _id: oid(id), ...fil, deletedAt: null }).select('provider providerMessageId').lean();
    if (!current) throw new SecretariatError('not_found', 'E-mail introuvable.');
    const sync = await mailboxSync(s);
    if (sync.sync) {
      const newId = await providerWrite(s.companyId, sync.provider, current, b.archived ? 'archive' : 'unarchive');
      if (newId) $set.providerMessageId = newId;
      mailbox = 'synced';
    }
  }
  const doc = await InboundEmail.findOneAndUpdate(
    { _id: oid(id), ...fil, deletedAt: null },
    { $set, ...(b.followUpId !== undefined ? { $addToSet: { followUpIds: oid(b.followUpId) } } : {}) },
    { new: true }
  ).lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  return { ...toItem(doc), mailbox };
}

/** Suppression logique (application seulement) : marqueur `deletedAt` + effacement des métadonnées ; le document reste jusqu'au TTL. Déjà supprimé / inconnu / autre portée : not_found (404). */
const DELETE_SET = () => ({ deletedAt: new Date(), fromName: '', fromEmail: '', subject: '', snippet: '', followUpIds: [] });

export async function deleteInbound(scope, id) {
  const s = asScope(scope);
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  if (isMine(s)) await loadMine(s);
  const filter = { _id: oid(id), ...scopeFilter(s), deletedAt: null };
  const doc = await InboundEmail.findOne(filter).select('provider providerMessageId').lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  // Réglage + autorisation d'écriture : MISE À LA CORBEILLE chez le fournisseur AVANT l'effacement local ; échec (≠ 404) : rien n'est effacé.
  const sync = await mailboxSync(s);
  if (sync.sync) await providerWrite(s.companyId, sync.provider, doc, 'trash');
  const res = await InboundEmail.updateOne(filter, { $set: DELETE_SET() });
  if (!res || !res.matchedCount) throw new SecretariatError('not_found', 'E-mail introuvable.');
  return { id: String(id), mailbox: sync.sync ? 'trashed' : 'app_only' };
}

/** Sélection d'un lot : exactement un de `ids` (1 à 100 identifiants valides) ou `status: 'handled'`. Renvoie { ids?: ObjectId[] } ou { status }. */
function parseBulk(body) {
  const b = plainBody(body);
  const hasIds = b.ids !== undefined; const hasStatus = b.status !== undefined;
  if (hasIds === hasStatus) throw new SecretariatError('invalid_request', 'Indiquez exactement un des paramètres « ids » ou « status ».');
  if (hasStatus) {
    if (b.status !== 'handled') throw new SecretariatError('invalid_request', 'Seul le statut « handled » est accepté.');
    return { status: 'handled' };
  }
  if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > MAX_BULK_IDS) throw new SecretariatError('invalid_request', `« ids » doit contenir de 1 à ${MAX_BULK_IDS} identifiants.`);
  if (!b.ids.every(isId)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  return { ids: [...new Set(b.ids.map((v) => v.toLowerCase()))].map(oid) };
}

/**
 * Suppression en lot. Par `status: 'handled'` : seulement les e-mails traités NON archivés (les archivés ne se suppriment que par `ids`).
 * Avec répercussion dans la messagerie : corbeille chez le fournisseur d'abord, effacement local des seuls réussis ; tous en échec : provider_error (502).
 * @returns {{deleted: number, failed?: number, mailbox: 'trashed'|'app_only'}}
 */
export async function deleteManyInbound(scope, body) {
  const s = asScope(scope);
  const sel = parseBulk(body);
  if (isMine(s)) await loadMine(s);
  const filter = { ...scopeFilter(s), deletedAt: null, ...(sel.ids ? { _id: { $in: sel.ids } } : { status: 'handled', archivedAt: null }) };
  const sync = await mailboxSync(s);
  if (!sync.sync) {
    const res = await InboundEmail.updateMany(filter, { $set: DELETE_SET() });
    return { deleted: res?.matchedCount ?? res?.modifiedCount ?? 0, mailbox: 'app_only' };
  }
  const docs = await InboundEmail.find(filter).select('provider providerMessageId').lean();
  const results = await providerWriteMany(s.companyId, sync.provider, docs, 'trash');
  const okIds = results.filter((r) => r.ok).map((r) => r.doc._id);
  const failed = results.length - okIds.length;
  if (failed > 0 && !okIds.length) throw new SecretariatError('provider_error', 'La messagerie est momentanément indisponible. Réessayez dans un instant.');
  if (okIds.length) await InboundEmail.updateMany({ ...scopeFilter(s), deletedAt: null, _id: { $in: okIds } }, { $set: DELETE_SET() });
  return { deleted: okIds.length, failed, mailbox: 'trashed' };
}

/**
 * Archivage / désarchivage en lot (`archived` défaut true). Compte les e-mails dont l'état a réellement changé. Avec répercussion dans la messagerie :
 * appel fournisseur d'abord, mise à jour locale des seuls réussis ; tous en échec : provider_error (502).
 * @returns {{updated: number, failed?: number, mailbox: 'synced'|'app_only'}}
 */
export async function archiveManyInbound(scope, body) {
  const s = asScope(scope);
  const sel = parseBulk(body);
  const b = plainBody(body);
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new SecretariatError('invalid_request', 'Le champ « archived » doit être un booléen.');
  const archived = b.archived !== false;
  if (isMine(s)) await loadMine(s);
  const filter = { ...scopeFilter(s), deletedAt: null, archivedAt: archived ? null : { $ne: null }, ...(sel.ids ? { _id: { $in: sel.ids } } : { status: 'handled' }) };
  const sync = await mailboxSync(s);
  if (!sync.sync) {
    const res = await InboundEmail.updateMany(filter, { $set: { archivedAt: archived ? new Date() : null } });
    return { updated: res?.matchedCount ?? res?.modifiedCount ?? 0, mailbox: 'app_only' };
  }
  const docs = await InboundEmail.find(filter).select('provider providerMessageId').lean();
  const results = await providerWriteMany(s.companyId, sync.provider, docs, archived ? 'archive' : 'unarchive');
  const ok = results.filter((r) => r.ok);
  const failed = results.length - ok.length;
  if (failed > 0 && !ok.length) throw new SecretariatError('provider_error', 'La messagerie est momentanément indisponible. Réessayez dans un instant.');
  const at = archived ? new Date() : null;
  for (const r of ok) await InboundEmail.updateOne({ _id: r.doc._id, ...scopeFilter(s), deletedAt: null }, { $set: { archivedAt: at, ...(r.newId ? { providerMessageId: r.newId } : {}) } });
  return { updated: ok.length, failed, mailbox: 'synced' };
}

/**
 * Arrêt de la lecture de la messagerie PERSONNELLE : la lecture est désactivée (le consentement n'est plus utilisé), les métadonnées stockées sont PURGÉES
 * immédiatement et plus rien n'est relu. Le jeton (qui sert aussi à l'envoi) n'est PAS révoqué chez le fournisseur : seule une déconnexion le fait.
 */
export async function stopMineReading(scope) {
  const s = asScope(scope);
  await loadMine(s);
  await SecretariatSharedAccount.updateOne({ _id: oid(s.accountId), companyId: oid(s.companyId), personalUserId: String(s.userId) }, { $set: { 'inbound.readEnabled': false } });
  await purgePersonalInbox(s.companyId, s.userId, s.accountId);
  attempts.delete(`mine:${s.accountId}`);
  return inboundView(s);
}
