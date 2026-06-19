/** Legal cooling-off window for sale commissions (days). */
export const RETRACTION_DAYS = 14;

export const RETRACTION_MS = RETRACTION_DAYS * 24 * 60 * 60 * 1000;

export function computeRetractionEndsAt(fromDate = new Date()) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  return new Date(base.getTime() + RETRACTION_MS);
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
