/**
 * Garde-fous déterministes appliqués à TOUTE réponse avant envoi, quoi que Claude ait produit.
 * En cas de violation, la réponse est remplacée par un transfert à un humain (jamais envoyée).
 */
// Noms INTERNES exacts des étapes du CRM. « mock call » (terme public) reste autorisé.
const STAGE_NAMES = /reps inscrits|completed profile|inscrit au projets\b|mock calls valid[ée] par le client/i;
const PERCENT = /\b\d{1,3}\s?%/;
const PLACEHOLDER = /\[\s*(?:À|A)\s*(?:COMPL[ÉE]TER|V[ÉE]RIFIER)/i;
const MONEY = /(?:\d[\d\s.,]*\s?(?:€|eur|euros|usd|\$|dollars|mad|dh|dirhams?))|(?:[€$]\s?\d)/i;
const TRANSFER = /(je vous (transf[èe]re|passe)|transf[ée]rer votre (chat|conversation)|prendr(a|e) le relais|conseiller (va|vous))/i;
const URL_LIKE = /https?:\/\/(?!(?:www\.)?harx\.ai\b)/i;

/** @returns {{ok: boolean, reason?: string}} */
export function checkReply(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'réponse vide' };
  if (t.length > 1200) return { ok: false, reason: 'réponse trop longue' };
  if (PLACEHOLDER.test(t)) return { ok: false, reason: 'contient [À COMPLÉTER]/[À VÉRIFIER]' };
  if (STAGE_NAMES.test(t)) return { ok: false, reason: "nom interne d'étape" };
  if (PERCENT.test(t)) return { ok: false, reason: 'pourcentage (pipeline)' };
  if (MONEY.test(t)) return { ok: false, reason: 'montant' };
  if (TRANSFER.test(t)) return { ok: false, reason: 'annonce un transfert (aucun opérateur ne prend le relais)' };
  if (URL_LIKE.test(t)) return { ok: false, reason: 'lien externe non validé' };
  return { ok: true };
}
