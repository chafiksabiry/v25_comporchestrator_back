import { channelOfConversation } from './agent.js';
import { isOpenState } from './caseStore.js';

/**
 * Indicateurs hebdomadaires de l'Inbox (spécification : demandes par canal et motif ; part résolue sans humain ; délai de première
 * réponse ; escalades au fondateur ; demandes ouvertes > 24 h). Calcul pur sur les demandes (tickets) et les dossiers de l'agent.
 *
 * « Résolue sans humain » : dossier clos, jamais escaladé, sans texte modifié par le fondateur ni réponse écrite à la main.
 * En mode brouillon, le clic « Envoyer » sur un brouillon non modifié compte comme une résolution par l'agent.
 */
const MIN = 60 * 1000;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function computeWeeklyMetrics({ tickets = [], cases = [], now = new Date(), days = 7 }) {
  const since = new Date(now.getTime() - days * 24 * 60 * MIN);
  const byTicket = new Map(cases.map((c) => [String(c.ticketId), c]));
  const recentTickets = tickets.filter((t) => new Date(t.createdAt) >= since && !String(t.waId).startsWith('identity:'));
  const byChannel = {}; const byMotif = {};
  for (const t of recentTickets) {
    const ch = channelOfConversation(t.waId);
    byChannel[ch] = (byChannel[ch] || 0) + 1;
    const motif = byTicket.get(String(t.id))?.classification?.motif || 'unclassified';
    byMotif[motif] = (byMotif[motif] || 0) + 1;
  }
  const recentCases = cases.filter((c) => new Date(c.createdAt) >= since);
  const closed = recentCases.filter((c) => c.state === 'closed');
  const withoutHuman = closed.filter((c) => !c.escalated && !c.humanEdited);
  const delays = recentCases.filter((c) => c.firstResponseAt).map((c) => (new Date(c.firstResponseAt) - new Date(c.createdAt)) / MIN).filter((x) => x >= 0);
  const escalations = recentCases.filter((c) => c.escalated);
  const byCategory = {};
  for (const c of escalations) for (const k of c.escalation?.categories || []) byCategory[k] = (byCategory[k] || 0) + 1;
  const limit = new Date(now.getTime() - 24 * 60 * MIN);
  const openOld = [
    ...cases.filter((c) => isOpenState(c.state) && new Date(c.createdAt) < limit).map((c) => ({ ticketId: String(c.ticketId), channel: c.channel, motif: c.classification?.motif || 'unclassified', state: c.state, ageHours: Math.floor((now - new Date(c.createdAt)) / (60 * MIN)) })),
    ...tickets.filter((t) => t.status !== 'resolved' && !byTicket.has(String(t.id)) && !String(t.waId).startsWith('identity:') && new Date(t.createdAt) < limit).map((t) => ({ ticketId: String(t.id), channel: channelOfConversation(t.waId), motif: 'unclassified', state: 'no_agent_case', ageHours: Math.floor((now - new Date(t.createdAt)) / (60 * MIN)) })),
  ].sort((a, b) => b.ageHours - a.ageHours);
  return {
    period: { from: since.toISOString(), to: now.toISOString(), days },
    requests: { total: recentTickets.length, byChannel, byMotif },
    resolvedWithoutHuman: { closed: closed.length, withoutHuman: withoutHuman.length, share: closed.length ? round((withoutHuman.length / closed.length) * 100) : null },
    firstResponseMinutes: { count: delays.length, median: round(median(delays)), average: round(delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null) },
    escalations: { total: escalations.length, byCategory },
    openOver24h: { total: openOld.length, items: openOld.slice(0, 20) },
  };
}
