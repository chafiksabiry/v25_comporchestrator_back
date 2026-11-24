import { detectForbidden, extractErrorCodes, extractAccountRef, replyLanguage, holdingMessage, confirmsResolution, FORBIDDEN_LABEL } from './rules.js';
import { checkOutgoing } from './guard.js';
import { SYSTEM_PROMPT, DECISION_SCHEMA, buildCasePrompt } from './prompt.js';
import { newDraftId, isOpenState } from './caseStore.js';

/**
 * Agent support IA (spécification validée le 24/11/2026).
 *
 * Cycle d'une demande de l'Inbox (ticket) :
 *  1. lecture : demande + historique + compte en LECTURE SEULE (isolation par société) + extraits de la base de connaissances ;
 *  2. décision : règles déterministes (cas interdits, incident multi-clients) + Claude (sortie JSON structurée) ; le plus prudent gagne ;
 *  3. réponse dans la langue du client (fr, en, es, ar) sur le canal d'origine :
 *       mode `draft`      -> brouillon visible dans l'Inbox, le fondateur clique « Envoyer » (ou « Modifier ») ;
 *       mode `autonomous` -> envoi direct ;
 *  4. cas interdit -> message d'attente (« réponse sous 24 h ouvrées »), résumé + diagnostic + recommandation, notification e-mail +
 *     webhook (copie à legal@ pour le juridique) ; le fondateur valide ou corrige en un clic, puis l'agent rédige la réponse finale ;
 *  5. clôture quand le client confirme, ou après 72 h sans réponse.
 * Garde-fous : jamais de secret, de donnée d'un autre client ni de pièce d'identité (checkOutgoing) ; tout est journalisé ; en cas de doute,
 * escalade. Aucune action sur le compte, le paiement ou les numéros : l'agent n'a aucun outil d'écriture.
 */
const AGENT_CHANNELS = ['whatsapp', 'web', 'email'];
export const channelOfConversation = (waId) => {
  const s = String(waId || '');
  if (s.startsWith('web:')) return 'web';
  if (s.startsWith('email:')) return 'email';
  if (s.startsWith('salesiq:')) return 'salesiq';
  if (s.startsWith('identity:')) return 'identity';
  return 'whatsapp';
};

const HOUR = 3600 * 1000;
const clip = (s, n) => String(s || '').slice(0, n);

/**
 * @param {object} deps
 * @param {object} deps.cfg            getSupportAgentConfig()
 * @param {object} deps.store          stockage de l'Inbox (conversations + tickets)
 * @param {object} deps.cases          stockage des dossiers de l'agent
 * @param {{createMessage: Function}|null} deps.claude   client Claude (src/salesiq/claudeClient.js) ; null = pas de clé
 * @param {object} deps.kb             base de connaissances (search)
 * @param {{read: Function}} deps.accountReader
 * @param {(conv: object, hints: {accountRef: string}) => Promise<{companyId: string|null, verified: boolean, contact?: object}>} deps.resolveCompany
 * @param {Record<string, (conv: object, text: string) => Promise<void>>} deps.senders   envoi par canal (whatsapp, web, email)
 * @param {(req: object) => Promise<object>} deps.notify   notificateur de l'équipe (src/support/notify.js)
 * @param {{supportNumber?: string}} [deps.contacts]
 */
export function createSupportAgent({ cfg, store, cases, claude, kb, accountReader, resolveCompany, senders, notify, contacts = {}, logger = console, now = () => new Date() }) {
  const queues = new Map();
  const serialize = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  };

  const log = (ticketId, entry) => cases.appendLog(ticketId, entry).catch((e) => logger.warn?.(`[support-agent] journal : ${e?.message || e}`));

  async function ensureCase(ticket) {
    const existing = await cases.get(ticket.id);
    if (existing) return existing;
    return cases.create({ ticketId: String(ticket.id), waId: ticket.waId, channel: channelOfConversation(ticket.waId), state: 'new' });
  }

  /** Demandes ouvertes sur le même code d'erreur, sociétés (ou conversations) distinctes, dans la fenêtre : incident multi-clients. */
  async function incidentFor(c, codes) {
    if (!codes.length) return null;
    const since = new Date(now().getTime() - cfg.incidentWindowMinutes * 60 * 1000);
    const recent = await cases.listRecentErrorCases(since);
    for (const code of codes) {
      const who = new Set(recent.filter((r) => (r.errorCodes || []).includes(code)).map((r) => r.companyId || r.waId));
      who.add(c.companyId || c.waId);
      if (who.size >= cfg.incidentThreshold) return { code, customers: who.size };
    }
    return null;
  }

  async function callModel({ channel, language, verified, snapshot, kbExcerpts, errorCodes, transcript, founderDecision }) {
    if (!claude) return { ok: false, error: 'not_configured' };
    try {
      const msg = await claude.createMessage({
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildCasePrompt({ channel, language, verified, snapshot, kbExcerpts, errorCodes, transcript, founderDecision, now: now() }) }],
        outputFormat: { type: 'json_schema', schema: DECISION_SCHEMA },
      });
      if (msg?.stop_reason === 'refusal') return { ok: false, error: 'refusal' };
      const text = (msg?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const data = JSON.parse(text);
      return { ok: true, data, model: msg?.model || claude.model };
    } catch (e) {
      logger.warn?.(`[support-agent] appel Claude en échec : ${e?.status || ''} ${clip(e?.message, 200)}`);
      return { ok: false, error: 'api_error' };
    }
  }

  /** Livre un texte au client sur le canal d'origine, puis l'ajoute à l'historique de la conversation. */
  async function deliver(conv, text, role) {
    const channel = channelOfConversation(conv.waId);
    const send = senders[channel];
    if (!send) throw new Error(`canal ${channel} sans envoi`);
    await send(conv, text);
    await store.appendMessage(conv.waId, { role, text, lang: null });
  }

  async function guardContext(conv, c, accountFacts) {
    const channel = channelOfConversation(conv.waId);
    const allowedPhones = [contacts.supportNumber, channel === 'whatsapp' ? conv.waId : ''].filter(Boolean);
    let customerEmail = '';
    try { customerEmail = channel === 'email' && contacts.customerEmail ? await contacts.customerEmail(conv) : ''; } catch { customerEmail = ''; }
    const allowedEmails = [cfg.supportEmail, 'support@harx.ai', cfg.legalEmail, customerEmail].filter(Boolean);
    return { allowedPhones, allowedEmails, verified: Boolean(c.verified), accountFacts };
  }

  async function sendDraftNow(c, draft, conv, { by, text = null }) {
    const finalText = text ?? draft.text;
    const edited = text != null && text.trim() !== String(draft.text).trim();
    if (edited) {
      // Texte modifié par le fondateur : seuls les secrets et les données de pièce restent bloquants (c'est un humain qui écrit).
      const g = checkOutgoing(finalText, { verified: true });
      const hard = g.violations.filter((v) => v.kind === 'secret' || v.kind === 'identity_document');
      if (hard.length) return { sent: false, error: 'guard', violations: hard };
    }
    await deliver(conv, finalText, by === 'founder' ? 'human_agent' : 'assistant');
    const at = now();
    const drafts = c.drafts.map((d) => (d.id === draft.id ? { ...d, status: 'sent', sentAt: at, sentBy: by, edited, text: finalText, originalText: edited ? d.text : undefined } : d));
    const patch = { drafts, firstResponseAt: c.firstResponseAt || at, humanEdited: Boolean(c.humanEdited || edited) };
    if (draft.kind !== 'holding') {
      Object.assign(patch, { state: 'awaiting_customer', awaitingSince: at });
      await store.updateTicket(c.ticketId, { status: 'in_progress' }).catch(() => {});
    }
    const updated = await cases.update(c.ticketId, patch);
    await log(c.ticketId, { action: 'sent', by, draftId: draft.id, kind: draft.kind, edited, text: finalText, reason: by === 'agent' ? 'mode autonome' : 'envoyé par le fondateur depuis l’Inbox' });
    return { sent: true, case: updated };
  }

  async function addDraft(c, conv, { kind, text, reason }) {
    const draft = { id: newDraftId(), kind, text, status: 'pending', createdAt: now(), reason };
    const drafts = [...(c.drafts || []).map((d) => (d.status === 'pending' && d.kind === kind ? { ...d, status: 'superseded' } : d)), draft];
    let updated = await cases.update(c.ticketId, { drafts });
    if (cfg.mode === 'autonomous') {
      const out = await sendDraftNow(updated, draft, conv, { by: 'agent' });
      updated = out.case || updated;
    }
    return { draft, case: updated };
  }

  async function escalate(c, conv, { categories, language, summary, diagnosis, recommendation, reason, sources, model, incident }) {
    const primary = categories[0] || 'uncertain';
    const legal = categories.includes('legal');
    const escalation = {
      categories, category: primary, label: FORBIDDEN_LABEL[primary], summary: clip(summary, 2000), diagnosis: clip(diagnosis, 2000), recommendation: clip(recommendation, 2000),
      legalCc: legal ? cfg.legalEmail : null, incident: incident || null, at: now(), decision: null,
    };
    let updated = await cases.update(c.ticketId, { escalation, escalated: true, state: 'awaiting_founder' });
    // Message d'attente : une seule fois par dossier.
    const alreadyHeld = (updated.drafts || []).some((d) => d.kind === 'holding' && ['pending', 'sent'].includes(d.status));
    if (!alreadyHeld) updated = (await addDraft(updated, conv, { kind: 'holding', text: holdingMessage(language), reason: `Cas escaladé : ${FORBIDDEN_LABEL[primary]}` })).case;
    let notified = null;
    try {
      notified = await notify({
        kind: 'escalation',
        channel: channelOfConversation(conv.waId),
        ticketId: String(c.ticketId),
        conversationId: conv.waId,
        urgency: primary === 'incident' || primary === 'legal' ? 'high' : 'normal',
        reason: `Agent support — décision requise : ${categories.map((k) => FORBIDDEN_LABEL[k]).join(' ; ')}`,
        summary: [summary && `Résumé : ${summary}`, diagnosis && `Diagnostic : ${diagnosis}`, recommendation && `Recommandation : ${recommendation}`].filter(Boolean).join('\n'),
        language,
        details: [incident ? `Incident : code ${incident.code} chez ${incident.customers} clients en ${cfg.incidentWindowMinutes} min` : '', legal ? `Copie : ${cfg.legalEmail}` : ''].filter(Boolean),
        cc: legal ? [cfg.legalEmail] : [],
      });
    } catch (e) { logger.warn?.(`[support-agent] notification : ${e?.message || e}`); }
    updated = await cases.update(c.ticketId, { escalation: { ...escalation, notified: notified ? { email: notified.email, webhook: notified.webhook } : { email: 'failed', webhook: 'failed' } } });
    await log(c.ticketId, { action: 'escalated', categories, reason, sources, model, text: summary, notified });
    return updated;
  }

  async function close(ticketId, reason) {
    const c = await cases.get(ticketId);
    if (!c || c.state === 'closed') return c;
    const at = now();
    const updated = await cases.update(ticketId, { state: 'closed', closedAt: at, closeReason: reason });
    await store.updateTicket(ticketId, { status: 'resolved', resolvedAt: at }).catch(() => {});
    const conv = await store.getConversation(c.waId);
    if (conv?.handoff?.active && String(conv.handoff.ticketId || '') === String(ticketId)) await store.updateConversation(c.waId, { handoff: { active: false } }).catch(() => {});
    await log(ticketId, { action: 'closed', reason });
    return updated;
  }

  async function analyse(c, ticket, conv, { founderDecision = null } = {}) {
    const msgs = conv.messages || [];
    const userMsgs = msgs.filter((m) => m.role === 'user');
    const newMsgs = userMsgs.slice(c.handledMessages || 0);
    const newText = (newMsgs.length ? newMsgs : userMsgs.slice(-1)).map((m) => m.text).join('\n');
    const allText = userMsgs.map((m) => m.text).join('\n');
    const language = replyLanguage(newText || allText, c.language || conv.language?.language || null);
    const errorCodes = extractErrorCodes(allText);
    const accountRef = extractAccountRef(allText);
    const sources = [`conversation (${msgs.length} messages)`, `demande ${ticket.id}`];

    let company = { companyId: null, verified: false };
    try { company = (await resolveCompany(conv, { accountRef })) || company; } catch (e) { logger.warn?.(`[support-agent] compte non résolu : ${e?.message || e}`); }
    let snapshot = null; let facts = [];
    if (company.companyId) {
      try {
        const read = await accountReader.read(company.companyId, { errorCodes });
        snapshot = read.snapshot; facts = read.facts; sources.push(...read.sources.map((s) => `compte : ${s}`));
      } catch (e) { sources.push('compte : lecture impossible'); }
    }
    sources.push(company.verified ? 'identité du demandeur : prouvée (compte lié)' : company.companyId ? 'identité du demandeur : NON prouvée (référence citée)' : 'aucun compte associé');
    c = await cases.update(c.ticketId, { language, errorCodes, companyId: company.companyId, verified: Boolean(company.verified) });

    const kbHits = kb ? kb.search(clip(`${newText}\n${ticket.reason || ''}`, 300), { limit: 4 }) : [];
    const kbExcerpts = kbHits.map((r) => ({ title: r.title, heading: r.heading, text: clip(r.text, 1500) }));
    if (kbExcerpts.length) sources.push(...kbExcerpts.map((k) => `base de connaissances : ${k.title}`));
    const transcript = msgs.slice(-30).map((m) => ({ role: m.role === 'user' ? 'Customer' : m.role === 'human_agent' ? 'HARX team' : m.role === 'system' ? 'System' : 'HARX assistant', text: clip(m.text, 1500) }));

    const det = detectForbidden(`${newText}\n${founderDecision ? '' : allText}`);
    const incident = founderDecision ? null : await incidentFor(c, errorCodes);
    const model = await callModel({ channel: c.channel, language, verified: company.verified, snapshot, kbExcerpts, errorCodes, transcript, founderDecision });
    return { c, language, errorCodes, sources, snapshot, facts, det, incident, model, newText };
  }

  /** Traite une demande (nouvelle escalade, passage périodique, nouveau message du client). */
  function processTicket(ticketId, { trigger = 'escalation' } = {}) {
    return serialize(String(ticketId), async () => {
      if (!cfg.enabled) return { skipped: 'disabled' };
      const ticket = await store.getTicket(ticketId);
      if (!ticket) return { skipped: 'no_ticket' };
      const channel = channelOfConversation(ticket.waId);
      if (!AGENT_CHANNELS.includes(channel)) return { skipped: `channel_${channel}` };
      let c = await ensureCase(ticket);
      if (!isOpenState(c.state)) return { skipped: 'closed' };
      const conv = await store.getConversation(ticket.waId);
      if (!conv) return { skipped: 'no_conversation' };
      if (ticket.status === 'resolved') { await close(ticket.id, 'demande close dans l’Inbox'); return { closed: 'ticket_resolved' }; }

      const userCount = (conv.messages || []).filter((m) => m.role === 'user').length;
      const fresh = userCount > (c.handledMessages || 0) || c.state === 'new';
      if (!fresh) {
        // Rien de nouveau : clôture après 72 h sans réponse du client.
        if (c.state === 'awaiting_customer' && c.awaitingSince && now() - new Date(c.awaitingSince) >= cfg.closeAfterHours * HOUR) {
          await close(ticket.id, `${cfg.closeAfterHours} h sans réponse du client`);
          return { closed: 'no_reply' };
        }
        return { skipped: 'nothing_new' };
      }
      // Le client confirme que c'est réglé.
      const last = (conv.messages || []).filter((m) => m.role === 'user').at(-1);
      if (c.state === 'awaiting_customer' && last && confirmsResolution(last.text)) {
        await cases.update(ticket.id, { handledMessages: userCount });
        await close(ticket.id, 'le client confirme que c’est réglé');
        return { closed: 'confirmed' };
      }
      if (c.state === 'awaiting_founder') {
        await cases.update(ticket.id, { handledMessages: userCount });
        await log(ticket.id, { action: 'noted', reason: 'nouveau message du client pendant l’attente de la décision du fondateur', sources: ['conversation'] });
        return { skipped: 'awaiting_founder' };
      }

      const a = await analyse(c, ticket, conv);
      c = a.c;
      const m = a.model.ok ? a.model.data : null;
      const categories = [...new Set([...(a.incident ? ['incident'] : []), ...a.det, ...((m?.forbidden_categories) || [])])];
      const classification = m ? { motif: m.motif, product: m.product, severity: a.incident ? 'critical' : m.severity } : { motif: 'other', product: 'unknown', severity: a.incident ? 'critical' : 'normal' };
      await cases.update(ticket.id, { classification, handledMessages: userCount });
      const modelName = a.model.ok ? a.model.model : null;

      if (m?.customer_confirmed_resolved && c.state === 'awaiting_customer') {
        await close(ticket.id, 'le client confirme que c’est réglé (modèle)');
        return { closed: 'confirmed' };
      }

      let reasonEsc = '';
      if (!a.model.ok) reasonEsc = `modèle indisponible (${a.model.error})`;
      else if (categories.length) reasonEsc = `cas interdit : ${categories.join(', ')}${a.det.length ? ` (règles : ${a.det.join(', ')})` : ''}`;
      else if (m.decision === 'escalate') reasonEsc = `le modèle escalade : ${clip(m.reason, 300)}`;
      else if (m.confidence === 'low') reasonEsc = 'confiance faible';
      else if (!String(m.reply || '').trim()) reasonEsc = 'réponse vide';

      if (!reasonEsc) {
        const g = checkOutgoing(m.reply, await guardContext(conv, c, a.facts));
        if (!g.ok) reasonEsc = `garde-fou : ${g.violations.map((v) => v.kind).join(', ')}`;
      }
      if (reasonEsc) {
        const cats = categories.length ? categories : ['uncertain'];
        const updated = await escalate(c, conv, {
          categories: cats, language: a.language, reason: reasonEsc, sources: a.sources, model: modelName, incident: a.incident,
          summary: m?.summary_for_founder || `Demande ${ticket.reason || ''} : ${clip(a.newText, 600)}`,
          diagnosis: m?.diagnosis || (a.incident ? `Code ${a.incident.code} signalé par ${a.incident.customers} clients en moins de ${cfg.incidentWindowMinutes} min.` : 'Diagnostic automatique indisponible.'),
          recommendation: m?.recommendation || 'Prendre la décision et répondre au client.',
        });
        return { escalated: true, categories: cats, reason: reasonEsc, case: updated };
      }
      const { draft, case: updated } = await addDraft(c, conv, { kind: 'reply', text: m.reply, reason: clip(m.reason, 500) });
      if (updated.state !== 'awaiting_customer') await cases.update(ticket.id, { state: 'draft_pending' });
      await log(ticket.id, { action: cfg.mode === 'autonomous' ? 'replied' : 'drafted', draftId: draft.id, text: m.reply, reason: clip(m.reason, 500), sources: a.sources, model: modelName, trigger });
      return { drafted: true, draftId: draft.id, sent: cfg.mode === 'autonomous', case: await cases.get(ticket.id) };
    });
  }

  /** Bouton « Envoyer » (texte du brouillon) ou « Modifier » puis « Envoyer » (texte corrigé) de l'Inbox. */
  function sendDraft(ticketId, draftId, { text = null } = {}) {
    return serialize(String(ticketId), async () => {
      const c = await cases.get(ticketId);
      if (!c) return { sent: false, error: 'not_found' };
      const draft = (c.drafts || []).find((d) => d.id === draftId);
      if (!draft || draft.status !== 'pending') return { sent: false, error: 'not_pending' };
      const conv = await store.getConversation(c.waId);
      if (!conv) return { sent: false, error: 'no_conversation' };
      const clean = text == null ? null : String(text).trim().slice(0, 4000);
      if (clean === '') return { sent: false, error: 'empty' };
      return sendDraftNow(c, draft, conv, { by: 'founder', text: clean });
    });
  }

  /** Décision du fondateur sur un cas escaladé (« Valider » ou « Corriger » + consigne) : l'agent rédige la réponse finale. */
  function decide(ticketId, { action, note = '' }) {
    return serialize(String(ticketId), async () => {
      if (!['approve', 'correct'].includes(action)) return { ok: false, error: 'invalid_action' };
      let c = await cases.get(ticketId);
      if (!c || !c.escalation) return { ok: false, error: 'not_escalated' };
      if (action === 'correct' && !String(note).trim()) return { ok: false, error: 'note_required' };
      const decision = { action, note: clip(note, 2000), at: now() };
      c = await cases.update(ticketId, { escalation: { ...c.escalation, decision } });
      await log(ticketId, { action: 'founder_decision', reason: action === 'approve' ? 'recommandation validée' : 'recommandation corrigée', text: decision.note });
      const ticket = await store.getTicket(ticketId);
      const conv = await store.getConversation(c.waId);
      if (!ticket || !conv) return { ok: false, error: 'no_conversation' };
      const a = await analyse(c, ticket, conv, { founderDecision: decision });
      const reply = a.model.ok ? String(a.model.data.reply || '').trim() : '';
      if (!reply) {
        await log(ticketId, { action: 'final_failed', reason: a.model.ok ? 'réponse vide' : `modèle indisponible (${a.model.error})` });
        return { ok: false, error: 'model_unavailable', case: await cases.get(ticketId) };
      }
      const g = checkOutgoing(reply, await guardContext(conv, a.c, a.facts));
      if (!g.ok) {
        await log(ticketId, { action: 'final_blocked', reason: `garde-fou : ${g.violations.map((v) => v.kind).join(', ')}` });
        return { ok: false, error: 'guard', case: await cases.get(ticketId) };
      }
      await cases.update(ticketId, { state: 'draft_pending' });
      const fresh = await cases.get(ticketId);
      const { draft } = await addDraft(fresh, conv, { kind: 'final', text: reply, reason: 'réponse finale après décision du fondateur' });
      await log(ticketId, { action: cfg.mode === 'autonomous' ? 'replied' : 'drafted', draftId: draft.id, text: reply, reason: 'réponse finale après décision du fondateur', sources: a.sources, model: a.model.model });
      return { ok: true, draftId: draft.id, case: await cases.get(ticketId) };
    });
  }

  /** Passage périodique (toutes les 15 min) : demandes ouvertes sans dossier, nouveaux messages, clôture à 72 h. */
  async function sweep() {
    if (!cfg.enabled) return { skipped: 'disabled' };
    const [open, progress] = await Promise.all([store.listTickets({ status: 'open' }), store.listTickets({ status: 'in_progress' })]);
    const tickets = [...open, ...progress].filter((t) => AGENT_CHANNELS.includes(channelOfConversation(t.waId)));
    const known = new Set(tickets.map((t) => String(t.id)));
    for (const c of await cases.listOpen()) if (!known.has(String(c.ticketId))) tickets.push({ id: c.ticketId, waId: c.waId });
    const results = [];
    for (const t of tickets) {
      try { results.push({ ticketId: t.id, ...(await processTicket(t.id, { trigger: 'sweep' })) }); } catch (e) { logger.warn?.(`[support-agent] passage ${t.id} : ${e?.message || e}`); results.push({ ticketId: t.id, error: e?.message }); }
    }
    return { processed: results.length, results };
  }

  /** Nouvelle escalade de l'assistant : traitée tout de suite, sans jamais retarder ni faire échouer la réponse au client. */
  function onEscalation(ticket) {
    if (!cfg.enabled || !ticket?.id) return Promise.resolve({ skipped: 'disabled' });
    return processTicket(ticket.id, { trigger: 'escalation' }).catch((e) => { logger.warn?.(`[support-agent] ${e?.message || e}`); return { error: e?.message }; });
  }

  return { processTicket, sendDraft, decide, close, sweep, onEscalation, cfg };
}
