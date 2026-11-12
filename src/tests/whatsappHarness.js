import http from 'http';
import jwt from 'jsonwebtoken';
import { detectLanguage } from '../whatsapp/language.js';

/** Serveur HTTP local qui imite la Graph API de Meta : enregistre chaque envoi, peut simuler des pannes. */
export async function startMockGraph() {
  const state = { sent: [], reads: [], failNext: [], authHeaders: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      state.authHeaders.push(req.headers.authorization);
      if (json.status === 'read') { state.reads.push(json); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"success":true}'); }
      const fail = state.failNext.shift();
      if (fail) { res.writeHead(fail.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: fail.message || 'fail', code: fail.code || 1 } })); }
      state.sent.push({ url: req.url, to: json.to, text: json.text?.body, raw: json });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${state.sent.length}` }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Imite GET /api/company-members/me du service d'inscription (vérifie le JWT court émis par l'agent). */
export async function startMockRegistration(secret, accounts) {
  const state = { calls: [] };
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').split(' ')[1];
    let claims;
    try { claims = jwt.verify(token, secret); } catch { res.writeHead(401); return res.end('{}'); }
    const url = new URL(req.url, 'http://x');
    state.calls.push({ claims, query: Object.fromEntries(url.searchParams) });
    const acc = accounts[claims.userId];
    if (!acc) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, data: acc }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

const REPLIES = {
  fr: (s) => `Voici la marche à suivre pour votre demande. ${s}`,
  en: (s) => `Here is how to proceed with your request. ${s}`,
  es: (s) => `Esta es la forma de proceder con tu solicitud. ${s}`,
  de: (s) => `So gehen Sie bei Ihrer Anfrage vor. ${s}`,
  ar: (s) => `إليك الخطوات المناسبة لطلبك. ${s}`,
  ary_ar: (s) => `هاكا غادي تدير باش تحل المشكل ديالك دابا. ${s}`,
  ary_lat: (s) => `Hak kifach ghadi tdir bach t7ell had lmochkil dyalek daba. ${s}`,
};
const pickTemplate = (lang, script) => (lang === 'ary' ? (script === 'arabic' ? 'ary_ar' : 'ary_lat') : REPLIES[lang] ? lang : 'en');

/**
 * « Claude » scripté pour tester toute la plomberie sans réseau : il lit l'indice de langue du prompt (comme le vrai
 * modèle), appelle les outils et répond dans la langue indiquée. Ce n'est PAS un test d'intelligence du modèle
 * (voir scripts/whatsappLiveClaudeTest.mjs pour le test avec la vraie API).
 */
export function createScriptedClaude() {
  const calls = [];
  let n = 0;
  const client = {
    model: 'scripted-claude',
    calls,
    async createMessage({ system, messages, tools }) {
      calls.push({ system, messages: JSON.parse(JSON.stringify(messages)), toolNames: tools.map((t) => t.name) });
      const dyn = system[system.length - 1].text;
      const m = /latest message: (.+?) \| script: (\w+) \| style/.exec(dyn);
      const code = Object.entries({ French: 'fr', English: 'en', Spanish: 'es', German: 'de', 'Modern Standard Arabic': 'ar', 'Moroccan Arabic (Darija)': 'ary' }).find(([k]) => m?.[1] === k)?.[1] || 'en';
      const tpl = pickTemplate(code, m?.[2]);
      const last = messages[messages.length - 1];
      const lastText = typeof last.content === 'string' ? last.content : '';
      const lastIsToolResult = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
      const text = (t) => ({ id: `msg_${++n}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
      const tool = (name, input) => ({ id: `msg_${++n}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: '' }, { type: 'tool_use', id: `tu_${n}`, name, input }] });

      if (/BOOM/.test(lastText)) throw Object.assign(new Error('upstream exploded'), { status: 529 });
      if (/REFUSE/.test(lastText)) return { id: `msg_${++n}`, role: 'assistant', stop_reason: 'refusal', content: [] };
      if (lastText.startsWith('[SYSTEM CORRECTION')) return text(REPLIES[tpl]('(corrected)'));
      if (lastIsToolResult) {
        const out = last.content.map((b) => b.content).join(' ');
        if (/ticket_created/.test(out)) return text(REPLIES[tpl]('Un ticket a été créé pour l’équipe support.'));
        if (/"linked":true/.test(out)) return text(REPLIES[tpl](`Votre forfait est ${/"plan":"([^"]+)"/.exec(out)?.[1] || '?'} (statut ${/"status":"([^"]+)"/.exec(out)?.[1] || '?'}).`));
        if (/"linked":false/.test(out)) return text(REPLIES[tpl]('Compte non lié: voir comment le lier.'));
        const src = /"topic":"([^"]+)"/.exec(out)?.[1];
        return text(REPLIES[tpl](src ? `(source: ${src})` : '(aucune source trouvée)'));
      }
      if (/FORCEWRONGLANG/.test(lastText)) return text(REPLIES.en('This is deliberately in English even if the user wrote another language, to test the guard.'));
      if (/LONG/.test(lastText)) return text(REPLIES[tpl](`${'Étape détaillée. '.repeat(500)}`));
      if (/ESCALATE/.test(lastText)) return tool('escalate_to_human', { reason: 'billing dispute', summary: 'User asks for a refund', urgency: 'high' });
      if (/ACCOUNT/.test(lastText)) return tool('get_my_account_overview', { userId: 'SOMEONE-ELSE', companyId: 'OTHER-COMPANY' });
      if (/ELSE-REMEMBER/.test(lastText)) return tool('remember_fact', { key: 'goal', value: 'create first gig' });
      return tool('search_knowledge', { query: 'activate gig setup steps' });
    },
  };
  return client;
}

export const detect = detectLanguage;

export function waitFor(cond, { timeout = 4000, step = 15 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v;
      try { v = cond(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'));
      return setTimeout(tick, step);
    };
    tick();
  });
}

/** Corps de webhook Meta (format officiel). */
export function metaPayload(messages, { phoneNumberId = 'PNID123' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '212711311388', phone_number_id: phoneNumberId },
          contacts: messages.map((m) => ({ profile: { name: m.name || 'Test User' }, wa_id: m.from })),
          messages: messages.map((m) => ({ from: m.from, id: m.id, timestamp: String(Math.floor(Date.now() / 1000)), type: m.type || 'text', ...(m.type && m.type !== 'text' ? { [m.type]: m.media || { id: 'media1' } } : { text: { body: m.text } }) })),
        },
      }],
    }],
  };
}
