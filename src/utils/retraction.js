/**
 * Legal cooling-off window for sale commissions (days) — EU default
 * (Directive 2011/83/EU art. 9). Used whenever a gig's destination country
 * has no `retractionDays` configured (cahier de recette PAY-10: this used
 * to be the ONLY value, applied to every country regardless of its own
 * law — see resolveRetractionDays below for the per-country resolution).
 */
export const RETRACTION_DAYS = 14;

export function computeRetractionEndsAt(fromDate = new Date(), retractionDays = RETRACTION_DAYS) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const days = Number.isFinite(retractionDays) && retractionDays >= 0 ? retractionDays : RETRACTION_DAYS;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the applicable retraction delay for a gig: the gig's own
 * `retractionDays` (ENT-13 — proposed from the country at gig creation,
 * editable by the company before publishing, then locked onto the gig)
 * when set, else its destination country's configured `retractionDays`
 * (admin-set, see adminCountriesService in v25_registration_backend),
 * falling back to the EU standard when unset or when the gig has no
 * destination country.
 */
export async function resolveRetractionDays(db, gigDoc) {
  if (typeof gigDoc?.retractionDays === 'number') return gigDoc.retractionDays;

  const countryId = gigDoc?.destination_zone;
  if (!countryId) return RETRACTION_DAYS;
  try {
    const countryObjectId = typeof countryId === 'object' ? countryId : countryId;
    const country = await db.collection('countries').findOne({ _id: countryObjectId });
    return typeof country?.retractionDays === 'number' ? country.retractionDays : RETRACTION_DAYS;
  } catch (err) {
    console.warn('[resolveRetractionDays] lookup failed, falling back to EU default:', err.message);
    return RETRACTION_DAYS;
  }
}

/** Rep share is withdrawable when status is earned/paid, or pending_retraction past withdrawableAt. */
export function isRepShareWithdrawable(row, now = new Date()) {
  if (!row || row.status === 'refused' || row.status === 'reversed') return false;
  if (row.status === 'earned' || row.status === 'paid') return true;
  if (row.status === 'pending_retraction') {
    if (!row.withdrawableAt) return false;
    return new Date(row.withdrawableAt).getTime() <= now.getTime();
  }
  return false;
}

export function isRepShareInRetraction(row, now = new Date()) {
  return row?.status === 'pending_retraction'
    && row.withdrawableAt
    && new Date(row.withdrawableAt).getTime() > now.getTime();
}
