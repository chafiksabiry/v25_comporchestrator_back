import mongoose from 'mongoose';
import InboundEmail from '../models/InboundEmail.js';
import FollowUpItem from '../models/FollowUpItem.js';
import SecretariatConnection from '../models/SecretariatConnection.js';
import SecretariatTools from '../models/SecretariatTools.js';
import { MAILBOX_PROVIDERS, withConnection } from './secretariatConnections.js';
import { purgeInboundEmails } from './inboundEmailStore.js';
import { loadTools, mergedTools } from './secretariatTools.js';
import { hasReadScope, SecretariatError } from './secretariatProviders/common.js';
import { PROVIDERS } from './secretariatProviders/index.js';

/**
 * E-mails ENTRANTS autorisés puis traités. Source = la messagerie connectée du centre (Gmail / Outlook) avec le scope OPTIONNEL de lecture.
 * Garde-fous : aucune lecture chez le fournisseur sans `inbound.enabled` ET sans scope de lecture ; seules des MÉTADONNÉES sont stockées
 * (modèle InboundEmail, TTL 30 jours) ; le corps est relu en direct à la demande, jamais stocké ni journalisé ; isolation stricte par centre.
 * Les appels aux fournisseurs (Gmail messages.list/get, Graph /me/mailFolders/inbox/messages) sont À VÉRIFIER en recette avec un vrai compte.
 */
export const PAGE_SIZE = 25;
export const REFRESH_MIN_INTERVAL_MS = 30_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const OID_RE = /^[0-9a-fA-F]{24}$/;
export const isId = (v) => typeof v === 'string' && OID_RE.test(v);

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
  return { canRead: true, mailbox: { provider: readable.provider, account: readable.accountEmail } };
}

const ERRORS = {
  inbound_disabled: 'La lecture des e-mails entrants n’est pas activée.',
  no_mailbox: 'Aucune messagerie n’est connectée. Connectez-la dans Paramétrage > Outils.',
  needs_reauth: 'La connexion de la messagerie a expiré ou a été révoquée. Reconnectez-la dans Paramétrage > Outils.',
  read_scope_missing: 'La messagerie connectée n’a pas l’autorisation de lecture. Autorisez la lecture dans Paramétrage > Outils.',
};

/** Contrôle d'accès à la lecture : lève inbound_disabled | no_mailbox | needs_reauth | read_scope_missing. */
async function requireReadAccess(companyId) {
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
  followUpIds: (d.followUpIds || []).map(String),
});

/** Vue renvoyée par GET et par le rafraîchissement. Ne lit RIEN chez le fournisseur. */
export async function inboundView(companyId) {
  const tools = mergedTools(await loadTools(companyId));
  const enabled = tools.inbound.enabled === true;
  const [located, rows] = await Promise.all([
    locateMailbox(companyId, tools.email.provider),
    enabled ? InboundEmail.find({ companyId: oid(companyId) }).sort({ receivedAt: -1 }).limit(PAGE_SIZE).lean() : [],
  ]);
  const last = tools.inbound.lastSyncAt ? new Date(tools.inbound.lastSyncAt) : null;
  return { enabled, canRead: located.canRead, lastSyncAt: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null, items: rows.map(toItem) };
}

/** Rafraîchissement : lit les messages récents chez le fournisseur et n'enregistre que des métadonnées. Au plus un appel fournisseur par centre toutes les 30 s. */
export async function refreshInbound(companyId, now = Date.now()) {
  const access = await requireReadAccess(companyId);
  const key = String(companyId);
  const lastSync = access.lastSyncAt ? new Date(access.lastSyncAt).getTime() : 0;
  if (now - Math.max(attempts.get(key) || 0, lastSync) < REFRESH_MIN_INTERVAL_MS) return inboundView(companyId); // trop tôt : état stocké, aucun appel fournisseur
  attempts.set(key, now);
  const messages = await withConnection(companyId, access.provider, (accessToken, http) => PROVIDERS[access.provider].listInbox({ http, accessToken, limit: PAGE_SIZE }));
  // Désactivé (ou retiré) pendant la lecture : on n'écrit rien.
  if (mergedTools(await loadTools(companyId)).inbound.enabled !== true) throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled);
  for (const m of messages.slice(0, PAGE_SIZE)) {
    await InboundEmail.updateOne(
      { companyId: oid(companyId), providerMessageId: m.id },
      { $setOnInsert: { provider: access.provider, fromName: m.fromName, fromEmail: m.fromEmail, subject: m.subject, receivedAt: m.receivedAt, snippet: m.snippet, status: 'new', followUpIds: [], fetchedAt: new Date() } },
      { upsert: true }
    );
  }
  await SecretariatTools.updateOne({ companyId: oid(companyId) }, { $set: { 'inbound.lastSyncAt': new Date(now) } });
  // Désactivé pendant l'écriture : purge (aucun résidu après un « off »).
  if (mergedTools(await loadTools(companyId)).inbound.enabled !== true) { await purgeInboundEmails(companyId); throw new SecretariatError('inbound_disabled', ERRORS.inbound_disabled); }
  return inboundView(companyId);
}

/** Corps d'un message lu EN DIRECT (texte, ≤ 20 000 caractères). Jamais stocké, jamais journalisé. */
export async function readInboundBody(companyId, id) {
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const access = await requireReadAccess(companyId);
  const doc = await InboundEmail.findOne({ _id: oid(id), companyId: oid(companyId) }).select('provider providerMessageId').lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  if (doc.provider !== access.provider) throw new SecretariatError('no_mailbox', ERRORS.no_mailbox); // la messagerie a changé depuis la lecture
  const text = await withConnection(companyId, access.provider, (accessToken, http) => PROVIDERS[access.provider].readBody({ http, accessToken, id: doc.providerMessageId }));
  return { text };
}

/** Marque « traité » et rattache (facultatif) un élément « À traiter » du MÊME centre. Fonctionne sans lecture chez le fournisseur. */
export async function markHandled(companyId, id, body) {
  if (!isId(id)) throw new SecretariatError('invalid_request', 'Identifiant d’e-mail invalide.');
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (b.status !== 'handled') throw new SecretariatError('invalid_request', 'Seul le statut « handled » est accepté.');
  if (b.followUpId !== undefined && !isId(b.followUpId)) throw new SecretariatError('invalid_request', 'Identifiant d’élément à traiter invalide.');
  if (b.followUpId !== undefined && !(await FollowUpItem.exists({ _id: oid(b.followUpId), companyId: oid(companyId) }))) throw new SecretariatError('invalid_request', 'Élément à traiter introuvable.');
  const doc = await InboundEmail.findOneAndUpdate(
    { _id: oid(id), companyId: oid(companyId) },
    { $set: { status: 'handled' }, ...(b.followUpId !== undefined ? { $addToSet: { followUpIds: oid(b.followUpId) } } : {}) },
    { new: true }
  ).lean();
  if (!doc) throw new SecretariatError('not_found', 'E-mail introuvable.');
  return toItem(doc);
}
