import Contact from '../models/Contact.js';
import ContactTombstone from '../models/ContactTombstone.js';
import { Subscription } from '../models/Subscription.js';
import { PHONE_SOURCE } from './contacts.js';

/**
 * Conservation des contacts synchronisés depuis le téléphone (Nomad), telle qu'annoncée dans la politique de confidentialité :
 * tant que la synchronisation est active, supprimés à la désactivation (route DELETE /api/contacts/sync), et supprimés
 * 90 jours après la résiliation de l'abonnement. Ce module fait la dernière partie : une société dont aucun abonnement
 * n'est encore en cours et dont la dernière résiliation date de plus de 90 jours perd ses fiches venues du téléphone
 * (même modifiées dans le portail) et ses traces de suppression. Une société sans aucun abonnement connu n'est pas touchée.
 */
export const RETENTION_AFTER_CANCEL_MS = 90 * 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

export const contactsRetentionDeps = {
  companiesWithPhoneContacts: () => Contact.distinct('companyId', { source: PHONE_SOURCE }),
  subscriptionsOf: (companyId) => Subscription.find({ companyId: String(companyId) }, { status: 1, updatedAt: 1 }).lean(),
  deletePhoneContacts: (companyId) => Contact.deleteMany({ companyId, source: PHONE_SOURCE }),
  deleteTombstones: (companyId) => ContactTombstone.deleteMany({ companyId }),
};

/** Vrai si la société est résiliée depuis plus de 90 jours (aucun abonnement en cours, dernière résiliation assez ancienne). */
export function expiredAfterCancel(subs, now = Date.now()) {
  if (!Array.isArray(subs) || subs.length === 0) return false;
  if (subs.some((s) => LIVE_STATUSES.includes(s.status))) return false;
  const canceled = subs.filter((s) => s.status === 'canceled' || s.status === 'incomplete_expired');
  if (canceled.length === 0) return false;
  const last = Math.max(...canceled.map((s) => new Date(s.updatedAt || 0).getTime()));
  return Number.isFinite(last) && last > 0 && now - last >= RETENTION_AFTER_CANCEL_MS;
}

export async function purgePhoneContactsAfterCancel({ now = Date.now(), deps = contactsRetentionDeps } = {}) {
  const companies = await deps.companiesWithPhoneContacts();
  let purged = 0;
  for (const companyId of companies) {
    try {
      const subs = await deps.subscriptionsOf(companyId);
      if (!expiredAfterCancel(subs, now)) continue;
      await deps.deletePhoneContacts(companyId);
      await deps.deleteTombstones(companyId);
      purged += 1;
    } catch (err) {
      console.warn('[contacts-retention]', String(companyId), err?.message || err);
    }
  }
  return { purged, checked: companies.length };
}
