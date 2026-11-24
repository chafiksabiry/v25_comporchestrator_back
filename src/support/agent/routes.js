import express from 'express';
import { computeWeeklyMetrics } from './metrics.js';
import { supportAgentBlockers } from './config.js';
import { supportGmailBlockers } from '../gmail/config.js';

/**
 * Routes d'administration de l'agent support, montées DANS le routeur de l'Inbox (/api/whatsapp/admin/agent/*) avec le même contrôle
 * d'accès (connexion admin du tableau de bord ou clé x-admin-key). Aucune route publique.
 */
const publicCase = (c) => c && ({
  ticketId: String(c.ticketId), waId: c.waId, channel: c.channel, state: c.state, language: c.language, verified: Boolean(c.verified),
  hasAccount: Boolean(c.companyId), classification: c.classification || null, errorCodes: c.errorCodes || [],
  drafts: (c.drafts || []).map((d) => ({ id: d.id, kind: d.kind, text: d.text, status: d.status, createdAt: d.createdAt, sentAt: d.sentAt || null, sentBy: d.sentBy || null, edited: Boolean(d.edited), reason: d.reason || '' })),
  escalation: c.escalation || null,
  log: (c.log || []).slice(-50),
  createdAt: c.createdAt, updatedAt: c.updatedAt, firstResponseAt: c.firstResponseAt || null, closedAt: c.closedAt || null, closeReason: c.closeReason || '',
});

export function mountSupportAgentRoutes(router, admin, { agent, cases, store, cfg, gmailCfg, logger = console }) {
  const json = express.json({ limit: '32kb' });
  const wrap = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return await fn(req, res); } catch (e) { logger.error?.(`[support-agent] route : ${e?.message || e}`); return res.status(500).json({ error: 'Support agent error' }); }
  };

  router.get('/admin/agent/status', admin, wrap(async (_req, res) => res.json({
    enabled: cfg.enabled, mode: cfg.mode, model: cfg.model, sweepMinutes: cfg.sweepMinutes, closeAfterHours: cfg.closeAfterHours,
    blockers: supportAgentBlockers(cfg),
    gmail: { enabled: Boolean(gmailCfg?.enabled), address: gmailCfg?.address || '', blockers: gmailCfg ? supportGmailBlockers(gmailCfg) : [] },
  })));

  // Demandes en attente du fondateur (badges de la liste de l'Inbox) : brouillon à envoyer ou décision à prendre.
  router.get('/admin/agent/pending', admin, wrap(async (_req, res) => {
    const open = await cases.listOpen();
    return res.json({ enabled: cfg.enabled, mode: cfg.mode, items: open.map((c) => ({ waId: c.waId, ticketId: String(c.ticketId), state: c.state, pendingDrafts: (c.drafts || []).filter((d) => d.status === 'pending').length, category: c.escalation?.category || null })).filter((x) => x.pendingDrafts || x.state === 'awaiting_founder') });
  }));

  router.get('/admin/agent/cases', admin, wrap(async (req, res) => {
    const waId = String(req.query.waId || '');
    if (!waId) return res.status(400).json({ error: 'waId is required' });
    return res.json({ mode: cfg.mode, enabled: cfg.enabled, cases: (await cases.listByConversation(waId)).map(publicCase) });
  }));

  router.post('/admin/agent/cases/:ticketId/drafts/:draftId/send', admin, json, wrap(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const out = await agent.sendDraft(req.params.ticketId, req.params.draftId, { text });
    if (!out.sent) return res.status(out.error === 'not_found' ? 404 : out.error === 'guard' ? 422 : 409).json({ error: out.error, violations: out.violations || [] });
    return res.json({ sent: true, case: publicCase(out.case) });
  }));

  router.post('/admin/agent/cases/:ticketId/decision', admin, json, wrap(async (req, res) => {
    const out = await agent.decide(req.params.ticketId, { action: String(req.body?.action || ''), note: String(req.body?.note || '') });
    if (!out.ok) return res.status(out.error === 'not_escalated' ? 404 : out.error === 'invalid_action' || out.error === 'note_required' ? 400 : 502).json({ error: out.error, case: publicCase(out.case) });
    return res.json({ ok: true, case: publicCase(out.case) });
  }));

  router.post('/admin/agent/cases/:ticketId/close', admin, wrap(async (req, res) => {
    const c = await agent.close(req.params.ticketId, 'close par le fondateur');
    if (!c) return res.status(404).json({ error: 'not_found' });
    return res.json({ case: publicCase(c) });
  }));

  router.post('/admin/agent/tickets/:ticketId/run', admin, wrap(async (req, res) => {
    const out = await agent.processTicket(req.params.ticketId, { trigger: 'manual' });
    return res.json({ ...out, case: out.case ? publicCase(out.case) : undefined });
  }));

  router.get('/admin/agent/metrics', admin, wrap(async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 3600 * 1000);
    const tickets = store.listTicketsSince ? await store.listTicketsSince(new Date(Math.min(since.getTime(), now.getTime() - 90 * 24 * 3600 * 1000))) : await store.listTickets({});
    const all = await cases.listSince(new Date(now.getTime() - 90 * 24 * 3600 * 1000));
    return res.json({ mode: cfg.mode, enabled: cfg.enabled, ...computeWeeklyMetrics({ tickets, cases: all, now, days }) });
  }));

  return router;
}

export { publicCase };
