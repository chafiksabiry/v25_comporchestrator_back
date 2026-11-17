// Run: JWT_SECRET=t node src/tests/consumptionJournal.test.js
// Journal de consommation (minutes | jetons) : lecture seule, titulaire uniquement. Sources simulées (aucune base réelle).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ScopeError } from '../middleware/companyScope.js';
import { createJournalHandlers } from '../controllers/consumptionJournalController.js';
import { maskCounterpart, csvCell, CSV_COLUMNS } from '../services/consumptionJournal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const C1 = '64b000000000000000000001';
const C2 = '64b000000000000000000002';

function res() {
  const r = { code: 200, body: null, headers: {}, text: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (t) => { r.text = t; return r; };
  return r;
}

// Données de deux sociétés ; les chargeurs ne renvoient que celles de la société demandée (comme le ferait une requête filtrée).
const D = (s) => new Date(s);
const store = {
  [C1]: {
    minutesWallet: {
      minutes: 100, planGrantKeys: ['sub_1:2026-09-01T00:00:00.000Z', 'sub_1:2026-10-01T00:00:00.000Z'],
      chargedCallSids: ['CA1', 'CA2', 'CA3', 'CA_ORPHAN', 'CA_INBOUND'],
      credits: [
        { at: D('2026-09-01T00:00:00Z'), minutes: 120, planName: 'Starter', kind: 'plan', grantKey: 'sub_1:2026-09-01T00:00:00.000Z' },
        { at: D('2026-10-01T00:00:00Z'), minutes: 120, planName: 'Starter', kind: 'plan', grantKey: 'sub_1:2026-10-01T00:00:00.000Z' },
      ],
    },
    tokensWallet: { tokens: 700, planTokensGranted: 1000, planGrantKeys: ['tokens:sub_1:2026-09-01T00:00:00.000Z'], consumedTokens: 800 },
    payments: [
      { _id: 'pay_min', purpose: 'minutes_purchase', status: 'succeeded', quantity: 50, amount: 5000, currency: 'EUR', provider: 'stripe', providerRef: 'cs_min', fulfilledAt: D('2026-10-05T10:00:00Z') },
      { _id: 'pay_tok', purpose: 'tokens_purchase', status: 'succeeded', quantity: 500, amount: 2500, currency: 'EUR', provider: 'stripe', providerRef: 'cs_tok', fulfilledAt: D('2026-10-06T10:00:00Z') },
      { _id: 'pay_bun', purpose: 'bundle_purchase', status: 'succeeded', amount: 9000, currency: 'EUR', provider: 'paypal', providerRef: 'ord_1', fulfilledAt: D('2026-10-07T10:00:00Z'), meta: { minutes: 30, tokens: 200, minutesCredited: true, tokensCredited: true } },
      { _id: 'pay_bun_half', purpose: 'bundle_purchase', status: 'succeeded', amount: 100, currency: 'EUR', provider: 'stripe', meta: { minutes: 999, tokens: 999, minutesCredited: false, tokensCredited: false } },
      { _id: 'pay_pending', purpose: 'minutes_purchase', status: 'pending', quantity: 77, amount: 1, currency: 'EUR', provider: 'stripe' },
    ],
    calls: [
      { sid: 'CA1', duration: 62, direction: 'outbound', from: '+33100000000', to: '+33612345678', startTime: D('2026-10-10T09:00:00Z') },
      { sid: 'CA2', duration: 10, direction: 'outbound', from: '+33100000000', to: '+447911123456', startTime: D('2026-10-11T09:00:00Z') },
      { sid: 'CA3', duration: 120, direction: 'outbound', to: 'client:abc', startTime: D('2026-10-12T09:00:00Z') },
      { sid: 'CA_INBOUND', duration: 59, direction: 'inbound', from: '+33699887766', to: '+33100000000', startTime: D('2026-10-13T09:00:00Z') },
      { sid: 'CA_NOT_CHARGED', duration: 600, direction: 'outbound', to: '+33600000000', startTime: D('2026-10-14T09:00:00Z') },
    ],
    usage: [
      { usageId: 'u1', tokensUsed: 300, tool: '=HYPERLINK("http://x")', provider: 'openai', model: 'gpt', gigId: 'g1', createdAt: D('2026-10-08T08:00:00Z') },
      { usageId: 'u2', tokensUsed: 500, tool: 'summary', provider: 'anthropic', model: 'claude', gigId: null, estimated: true, createdAt: D('2026-10-09T08:00:00Z') },
    ],
  },
  [C2]: {
    minutesWallet: { minutes: 5, planGrantKeys: [], chargedCallSids: ['CB1'], credits: [{ at: D('2026-10-02T00:00:00Z'), minutes: 5, planName: 'Other', kind: 'plan', grantKey: 'sub_2:2026-10-02T00:00:00.000Z' }] },
    tokensWallet: { tokens: 9, planTokensGranted: 0, planGrantKeys: [], consumedTokens: 1 },
    payments: [{ _id: 'pay_c2', purpose: 'minutes_purchase', status: 'succeeded', quantity: 9999, amount: 1, currency: 'EUR', provider: 'stripe', fulfilledAt: D('2026-10-03T00:00:00Z') }],
    calls: [{ sid: 'CB1', duration: 600, direction: 'outbound', to: '+33777777777', startTime: D('2026-10-04T00:00:00Z') }],
    usage: [{ usageId: 'uB', tokensUsed: 1, tool: 'secret-c2', createdAt: D('2026-10-04T00:00:00Z') }],
  },
};
const seen = [];
const loaders = {
  minutes: async (companyId) => { seen.push(['minutes', companyId]); const s = store[companyId] || {}; return { wallet: s.minutesWallet || null, payments: s.payments || [], calls: s.calls || [] }; },
  tokens: async (companyId) => { seen.push(['tokens', companyId]); const s = store[companyId] || {}; return { wallet: s.tokensWallet || null, payments: s.payments || [], usage: s.usage || [] }; },
};
const h = (access = { userId: 'u', companyId: C1, role: 'owner', isOwner: true }) => createJournalHandlers({ getAccess: async () => access, loaders });
const get = async (query = {}, access, fn = 'list') => { const r = res(); await h(access)[fn]({ query, headers: {} }, r); return r; };

// ---------- Accès ----------
for (const role of ['member', 'agent']) {
  const r = await get({ type: 'minutes' }, { userId: 'u', companyId: C1, role });
  assert.equal(r.code, 403, `${role} refusé`); assert.equal(r.body.code, 'forbidden');
  const x = await get({ type: 'minutes' }, { userId: 'u', companyId: C1, role }, 'exportCsv');
  assert.equal(x.code, 403, `${role} refusé (CSV)`); assert.equal(x.text, null);
}
{
  seen.length = 0;
  assert.equal((await get({ type: 'minutes' }, { userId: 'u', companyId: null, role: 'owner', isOwner: true })).code, 404);
  assert.equal(seen.length, 0, 'aucune lecture sans société');
  let r = res(); await createJournalHandlers({ getAccess: async () => { throw new ScopeError(401, 'Authentication required'); }, loaders }).list({ query: { type: 'minutes' } }, r);
  assert.equal(r.code, 401);
  r = res(); await createJournalHandlers({ getAccess: async () => { throw new Error('down'); }, loaders }).list({ query: { type: 'minutes' } }, r);
  assert.equal(r.code, 503); assert.equal(r.body.code, 'unavailable');
  r = res(); await createJournalHandlers({ getAccess: async () => { throw new ScopeError(503, 'Company lookup failed'); }, loaders }).list({ query: { type: 'minutes' } }, r);
  assert.equal(r.code, 503);
}

// ---------- Titulaire : preuve positive exigée (le rôle « owner » est accordé par défaut côté annuaire) ----------
for (const access of [{ companyId: C1, role: 'owner' }, { companyId: C1, role: 'owner', isOwner: false }, { companyId: C1, role: 'owner', isOwner: 'true' }, { companyId: C1, role: 'Owner', isOwner: true }, { companyId: C1, isOwner: true }]) {
  const r = await get({ type: 'minutes' }, access);
  assert.equal(r.code, 403, JSON.stringify(access));
}

// ---------- Isolation : la société vient de l'authentification, jamais de la requête ----------
{
  seen.length = 0;
  const r = await get({ type: 'minutes', companyId: C2, limit: '200' });
  assert.deepEqual(seen, [['minutes', C1]], 'seule la société du titulaire est lue, malgré ?companyId=C2');
  const blob = JSON.stringify(r.body);
  for (const leak of ['CB1', 'pay_c2', '9999', 'Other', C2]) assert.ok(!blob.includes(leak), `fuite ${leak}`);
  const t = await get({ type: 'tokens', limit: '200' });
  assert.ok(!JSON.stringify(t.body).includes('secret-c2'));
  const owner2 = await get({ type: 'minutes' }, { userId: 'u2', companyId: C2, role: 'owner', isOwner: true });
  assert.ok(!JSON.stringify(owner2.body).includes('CA1'));
  assert.equal(owner2.body.data.summary.currentBalance, 5);
}

// ---------- Minutes : contenu ----------
const rowsOf = (r) => r.body.data.items;
{
  const r = await get({ type: 'minutes', limit: '200' });
  assert.equal(r.code, 200); assert.equal(r.body.success, true);
  const rows = rowsOf(r);
  const by = (id) => rows.find((x) => x.id === id);
  // octrois du forfait
  const g = rows.filter((x) => x.nature === 'octroi_forfait');
  assert.equal(g.length, 2); assert.ok(g.every((x) => x.quantity === 120 && x.reference.planName === 'Starter'));
  // recharges : achat direct + moitié « minutes » du pack ; la moitié non créditée et l'achat en attente n'y sont pas
  const rech = rows.filter((x) => x.nature === 'recharge');
  assert.deepEqual(rech.map((x) => [x.reference.paymentId, x.quantity]).sort(), [['pay_bun', 30], ['pay_min', 50]]);
  assert.equal(by('payment:pay_min:minutes').reference.provider, 'stripe');
  assert.equal(by('payment:pay_bun:minutes').reference.pack.tokens, 200);
  // consommations : ceil(s/60), seulement les appels réellement débités (chargedCallSids), pas l'orphelin ni le non débité
  const cons = rows.filter((x) => x.nature === 'consommation');
  assert.deepEqual(cons.map((x) => [x.reference.callSid, x.quantity]).sort(), [['CA1', -2], ['CA2', -1], ['CA3', -2], ['CA_INBOUND', -1]]);
  assert.equal(by('call:CA1').reference.durationSeconds, 62);
  assert.equal(by('call:CA1').reference.direction, 'outbound');
  assert.equal(by('call:CA_INBOUND').reference.direction, 'inbound');
  // champs prévus pour la future classe national / international : présents et nuls, jamais inventés
  for (const c of cons) { assert.equal(c.coefficient, null); assert.equal(c.zone, null); }
  // traçabilité
  assert.ok(g.every((x) => x.reconstructed === false));
  assert.ok(cons.every((x) => x.reconstructed === true));
  assert.equal(r.body.data.summary.orphanDebitedCalls, 1);
  // ordre : le plus récent d'abord
  const dates = rows.map((x) => x.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
}

// ---------- Masquage des numéros ----------
{
  assert.equal(maskCounterpart('+33612345678'), '•••••••••78');
  assert.equal(maskCounterpart('0612345678'), '••••••••78');
  assert.equal(maskCounterpart('+33 6 12 34 56 78'), '•••••••••78', 'espaces et séparateurs ignorés');
  assert.equal(maskCounterpart('client:abc'), null);
  assert.equal(maskCounterpart(''), null);
  assert.equal(maskCounterpart(undefined), null);
  assert.equal(maskCounterpart('+3361'), null, 'trop court pour être un numéro : rien');
  const r = await get({ type: 'minutes', limit: '200' });
  const blob = JSON.stringify(r.body);
  for (const raw of ['+33612345678', '33612345678', '612345678', '447911123456', '699887766', '33100000000', '+33100000000', 'client:abc']) {
    assert.ok(!blob.includes(raw), `numéro ou identifiant en clair : ${raw}`);
  }
  const ca1 = rowsOf(r).find((x) => x.id === 'call:CA1');
  assert.equal(ca1.reference.counterpart, '•••••••••78');
  // sens entrant : on masque l'appelant (from), jamais le numéro de la société (to)
  assert.equal(rowsOf(r).find((x) => x.id === 'call:CA_INBOUND').reference.counterpart, '•••••••••66');
  // pas de champ from / to bruts
  assert.ok(!('from' in ca1.reference) && !('to' in ca1.reference));
}

// ---------- Jetons : contenu ----------
{
  const r = await get({ type: 'tokens', limit: '200' });
  const rows = rowsOf(r);
  const grant = rows.filter((x) => x.nature === 'octroi_forfait');
  assert.equal(grant.length, 1);
  assert.equal(grant[0].quantity, 1000, 'une seule clé : la quantité est le cumul planTokensGranted');
  assert.equal(grant[0].date, '2026-09-01T00:00:00.000Z');
  assert.equal(grant[0].reconstructed, true);
  assert.deepEqual(rows.filter((x) => x.nature === 'recharge').map((x) => [x.reference.paymentId, x.quantity]).sort(), [['pay_bun', 200], ['pay_tok', 500]]);
  const u1 = rows.find((x) => x.reference.usageId === 'u1');
  assert.equal(u1.quantity, -300);
  assert.deepEqual([u1.reference.usageId, u1.reference.tool, u1.reference.provider, u1.reference.model, u1.reference.gigId], ['u1', '=HYPERLINK("http://x")', 'openai', 'gpt', 'g1']);
  assert.equal(rows.find((x) => x.reference.usageId === 'u2').reference.estimated, true);
  assert.equal(u1.reconstructed, false);
}
{
  // plusieurs clés : quantité par période inconnue, jamais devinée
  const local = JSON.parse(JSON.stringify(store[C1].tokensWallet));
  local.planGrantKeys.push('tokens:sub_1:2026-10-01T00:00:00.000Z'); local.planTokensGranted = 2000;
  const hh = createJournalHandlers({ getAccess: async () => ({ companyId: C1, role: 'owner', isOwner: true }), loaders: { ...loaders, tokens: async () => ({ wallet: local, payments: [], usage: [] }) } });
  const r = res(); await hh.list({ query: { type: 'tokens', nature: 'octroi_forfait' } }, r);
  assert.equal(r.body.data.items.length, 2);
  assert.ok(r.body.data.items.every((x) => x.quantity === null && x.quantityApproximate === true));
  assert.equal(r.body.data.summary.unattributedPlanGrant, 2000);
  assert.equal(r.body.data.summary.unexplained, null, 'écart non calculable quand une quantité est inconnue');
}

// ---------- Solde après opération & écart non expliqué ----------
{
  const r = await get({ type: 'minutes', limit: '200' });
  const chrono = [...rowsOf(r)].reverse();
  // dernier = solde actuel ; chaque ligne = suivante - quantité de la suivante
  assert.equal(chrono.at(-1).balanceAfter, 100);
  for (let i = chrono.length - 2; i >= 0; i--) assert.equal(chrono[i].balanceAfter, chrono[i + 1].balanceAfter - chrono[i + 1].quantity);
  const net = chrono.reduce((a, x) => a + x.quantity, 0); // 240+50+30-2-1-2-1 = 314
  assert.equal(net, 314);
  assert.equal(r.body.data.summary.currentBalance, 100);
  assert.equal(r.body.data.summary.unexplained, 100 - 314, 'solde actuel - somme du journal : jamais absorbé en silence');
  // même solde, quelle que soit la page demandée
  const p2 = await get({ type: 'minutes', limit: '2', page: '2' });
  assert.equal(rowsOf(p2)[0].balanceAfter, rowsOf(r)[2].balanceAfter);
}

// ---------- Pagination ----------
{
  const all = rowsOf(await get({ type: 'minutes', limit: '200' }));
  assert.equal(all.length, 8);
  const p1 = await get({ type: 'minutes', limit: '4', page: '1' });
  const p2b = await get({ type: 'minutes', limit: '4', page: '2' });
  const p3 = await get({ type: 'minutes', limit: '4', page: '3' });
  assert.equal(p1.body.data.total, 8); assert.equal(p1.body.data.totalPages, 2); assert.equal(p1.body.data.page, 1); assert.equal(p1.body.data.limit, 4);
  assert.deepEqual(rowsOf(p1).map((x) => x.id), all.slice(0, 4).map((x) => x.id));
  assert.deepEqual(rowsOf(p2b).map((x) => x.id), all.slice(4).map((x) => x.id));
  assert.deepEqual(rowsOf(p3), []);
  // défaut et plafond
  assert.equal((await get({ type: 'minutes' })).body.data.limit, 50);
  assert.equal((await get({ type: 'minutes', limit: '100000' })).body.data.limit, 200);
  for (const bad of [{ page: '0' }, { page: '-1' }, { page: 'x' }, { limit: '0' }, { limit: 'abc' }, { page: '1.5' }]) {
    const r = await get({ type: 'minutes', ...bad });
    assert.equal(r.code, 400, JSON.stringify(bad)); assert.equal(r.body.code, 'invalid_pagination');
  }
}

// ---------- Filtres : type, période, nature ----------
{
  for (const t of [undefined, '', 'sms', 'MINUTES ', ['minutes']]) {
    const r = await get({ type: t });
    assert.equal(r.code, 400); assert.equal(r.body.code, 'invalid_type');
  }
  const cons = await get({ type: 'minutes', nature: 'consommation', limit: '200' });
  assert.equal(cons.body.data.total, 4); assert.ok(rowsOf(cons).every((x) => x.nature === 'consommation'));
  const multi = await get({ type: 'minutes', nature: 'recharge,octroi_forfait', limit: '200' });
  assert.equal(multi.body.data.total, 4);
  const none = await get({ type: 'minutes', nature: 'ajustement' });
  assert.equal(none.code, 200); assert.equal(none.body.data.total, 0);
  assert.equal((await get({ type: 'minutes', nature: 'vol' })).body.code, 'invalid_nature');
  // période : bornes incluses, « to » en date seule = fin de journée
  const oct = await get({ type: 'minutes', from: '2026-10-05', to: '2026-10-07', limit: '200' });
  assert.deepEqual(rowsOf(oct).map((x) => x.id).sort(), ['payment:pay_bun:minutes', 'payment:pay_min:minutes']);
  const day = await get({ type: 'minutes', from: '2026-10-10T09:00:00Z', to: '2026-10-10T09:00:00Z' });
  assert.deepEqual(rowsOf(day).map((x) => x.id), ['call:CA1']);
  for (const bad of [{ from: 'hier' }, { to: '2026-13-45' }, { from: '2026-10-05', to: '2026-10-01' }]) {
    const r = await get({ type: 'minutes', ...bad });
    assert.equal(r.code, 400, JSON.stringify(bad)); assert.ok(['invalid_date', 'invalid_range'].includes(r.body.code));
  }
  // le solde après opération ne dépend pas du filtre
  const filtered = await get({ type: 'minutes', nature: 'consommation', limit: '200' });
  const full = rowsOf(await get({ type: 'minutes', limit: '200' }));
  for (const row of rowsOf(filtered)) assert.equal(row.balanceAfter, full.find((x) => x.id === row.id).balanceAfter);
}

// ---------- Résumé exact ----------
{
  const all = await get({ type: 'minutes' });
  assert.deepEqual({ ...all.body.data.summary }, {
    granted: 240, recharged: 80, consumed: 6, adjusted: 0, expired: 0, currentBalance: 100, unexplained: 100 - 314, orphanDebitedCalls: 1,
    from: null, to: null,
  });
  // période : octobre jusqu'au 10 inclus ; le filtre de nature n'altère pas les totaux
  const p = await get({ type: 'minutes', from: '2026-10-01', to: '2026-10-10', nature: 'recharge' });
  const s = p.body.data.summary;
  assert.deepEqual([s.granted, s.recharged, s.consumed, s.adjusted], [120, 80, 2, 0]);
  assert.equal(s.currentBalance, 100); assert.equal(s.from, '2026-10-01T00:00:00.000Z'); assert.equal(s.to, '2026-10-10T23:59:59.999Z');
  assert.equal(p.body.data.total, 2, 'la liste, elle, est filtrée par nature');
  const t = (await get({ type: 'tokens' })).body.data.summary;
  assert.deepEqual([t.granted, t.recharged, t.consumed, t.currentBalance, t.unexplained], [1000, 700, 800, 700, 700 - (1000 + 700 - 800)]);
}

// ---------- Export CSV ----------
{
  assert.equal(csvCell('=1+1'), "'=1+1"); assert.equal(csvCell('+33612345678'), "'+33612345678");
  assert.equal(csvCell('-2+3'), "'-2+3"); assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tcmd'), "\"'\tcmd\""); assert.equal(csvCell('\rcmd'), "\"'\rcmd\"");
  assert.equal(csvCell('  =trim'), "'  =trim", 'espaces initiaux : toujours neutralisé');
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(csvCell(-5), '-5', 'nombre : valeur numérique, pas du texte'); assert.equal(csvCell(null), ''); assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(Number.NaN), '');

  const r = await get({ type: 'tokens', nature: 'consommation' }, undefined, 'exportCsv');
  assert.equal(r.code, 200);
  assert.match(r.headers['content-type'], /^text\/csv; charset=utf-8/);
  assert.match(r.headers['content-disposition'], /^attachment; filename="journal-consommation-tokens-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(r.text.startsWith('\uFEFF' + CSV_COLUMNS.join(',') + '\r\n'));
  assert.equal(CSV_COLUMNS.slice(0, 8).join(','), 'date,type,nature,quantity,balance_after,coefficient,zone,reconstructed');
  const lines = r.text.replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 3, 'en-tête + 2 consommations (même filtre que la liste)');
  // le nom d'outil piégé est neutralisé (jamais une formule exécutable), et seules les cellules texte sont touchées
  assert.ok(r.text.includes(`'=HYPERLINK`));
  assert.ok(!/(^|,|")=HYPERLINK/m.test(r.text), 'aucune cellule ne commence par =');
  for (const l of lines.slice(1)) assert.ok(/^20\d\d-\d\d-\d\dT/.test(l));
  assert.ok(lines.some((l) => l.includes(',tokens,consommation,-300,')));

  // masquage dans l'export, mêmes filtres, mêmes accès, isolation
  const m = await get({ type: 'minutes', from: '2026-10-10', to: '2026-10-13' }, undefined, 'exportCsv');
  for (const raw of ['33612345678', '447911123456', '699887766', '33100000000', 'client:abc']) assert.ok(!m.text.includes(raw), raw);
  assert.ok(m.text.includes('•••••••••78'));
  assert.ok(!m.text.includes('CB1'));
  const lm = m.text.replace('﻿', '').trim().split('\r\n');
  assert.equal(lm.length, 1 + 4);
  const bad = await get({ type: 'bogus' }, undefined, 'exportCsv');
  assert.equal(bad.code, 400); assert.equal(bad.text, null); assert.equal(bad.body.code, 'invalid_type');
  const badDate = await get({ type: 'minutes', from: 'zzz' }, undefined, 'exportCsv');
  assert.equal(badDate.code, 400);
}

// ---------- Cas limites relevés à la relecture ----------
{
  const mk = (min, tok) => createJournalHandlers({ getAccess: async () => ({ companyId: C1, role: 'owner', isOwner: true }), loaders: { minutes: async () => min, tokens: async () => tok } });
  const call = async (hh, q, fn = 'list') => { const r = res(); await hh[fn]({ query: q }, r); return r; };
  // même sid dans deux documents : une seule ligne
  let r = await call(mk({ wallet: { minutes: 0, chargedCallSids: ['A'], credits: [] }, payments: [], calls: [{ sid: 'A', duration: 60, direction: 'outbound', to: '+33612345678', startTime: D('2026-10-01') }, { sid: 'A', duration: 60, direction: 'outbound', startTime: D('2026-10-01') }] }), { type: 'minutes' });
  assert.deepEqual(r.body.data.items.map((x) => [x.id, x.quantity]), [['call:A', -1]]);
  // sens Twilio « outbound-api » / « inbound »
  r = await call(mk({ wallet: { minutes: 0, chargedCallSids: ['B', 'C'], credits: [] }, payments: [], calls: [{ sid: 'B', duration: 30, direction: 'outbound-api', to: '+33600000012', startTime: D('2026-10-01') }, { sid: 'C', duration: 30, direction: 'inbound', from: '+33600000034', startTime: D('2026-10-02') }] }), { type: 'minutes' });
  assert.deepEqual(r.body.data.items.map((x) => [x.reference.direction, x.reference.counterpart]), [['inbound', '•••••••••34'], ['outbound', '•••••••••12']]);
  // coefficient : connu (entier >= 1 et zone connue) => quantité = -(minutes arrondies x coefficient) ; sinon historique, coefficient null
  const calls = [{ sid: 'I', duration: 61, startTime: D('2026-10-01') }, { sid: 'J', duration: 61, startTime: D('2026-10-02') }, { sid: 'K', duration: 61, startTime: D('2026-10-03') }, { sid: 'L', duration: 61, startTime: D('2026-10-04') }];
  r = await call(mk({ wallet: { minutes: 0, chargedCallSids: ['I', 'J', 'K', 'L'], credits: [] }, payments: [], calls, debits: { I: { coefficient: 4, zone: 'international' }, J: { coefficient: 1, zone: 'domestic' }, K: { coefficient: 4, zone: null }, L: { coefficient: 2.5, zone: 'international' } } }), { type: 'minutes' });
  const q = Object.fromEntries(r.body.data.items.map((x) => [x.reference.callSid, [x.quantity, x.coefficient, x.zone]]));
  assert.deepEqual(q, { I: [-8, 4, 'international'], J: [-2, 1, 'domestic'], K: [-2, null, null], L: [-2, null, null] });
  // lignes sans date : jamais de solde après opération inventé
  r = await call(mk({ wallet: { minutes: 10, chargedCallSids: ['U', 'V'], credits: [] }, payments: [], calls: [{ sid: 'U', duration: 60 }, { sid: 'V', duration: 60, startTime: D('2026-10-01') }] }), { type: 'minutes' });
  assert.ok(r.body.data.items.every((x) => x.balanceAfter === null));
  // journal cohérent : somme = solde => rien d'inexpliqué ; solde après opération exact
  r = await call(mk({ wallet: { minutes: 7, chargedCallSids: ['X'], credits: [{ at: D('2026-10-01'), minutes: 10, kind: 'plan', planName: 'P', grantKey: 'g:2026-10-01T00:00:00.000Z' }] }, payments: [{ _id: 'p1', purpose: 'minutes_purchase', status: 'succeeded', quantity: '10.005', fulfilledAt: D('2026-10-02') }], calls: [{ sid: 'X', duration: 120, startTime: D('2026-10-03') }] }), { type: 'minutes' });
  assert.equal(r.body.data.summary.unexplained, round(7 - (10 + 10.01 - 2)));
  assert.deepEqual(r.body.data.items.map((x) => x.balanceAfter), [7, 9, -1.01 + 0 === 0 ? 0 : round(9 - 10.01)]);
  assert.equal(r.headers['cache-control'], 'no-store');
  // PII dans les champs libres d'un service tiers non authentifié
  r = await call(mk(null, { wallet: { tokens: 0 }, payments: [], usage: [{ usageId: 'call-+33612345678', tokensUsed: 5, tool: 'dial +33 6 12 34 56 78', model: '0612345678', provider: 'x', createdAt: D('2026-10-01') }] }), { type: 'tokens' });
  let blob = JSON.stringify(r.body);
  for (const raw of ['33612345678', '612345678', '0612345678', '6 12 34 56 78']) assert.ok(!blob.includes(raw), raw);
  r = await call(mk(null, { wallet: { tokens: 0 }, payments: [], usage: [{ usageId: 'call-+33612345678', tokensUsed: 5, tool: 'dial +33 6 12 34 56 78', model: '0612345678', createdAt: D('2026-10-01') }] }), { type: 'tokens' }, 'exportCsv');
  for (const raw of ['33612345678', '0612345678', '6 12 34 56 78']) assert.ok(!r.text.includes(raw), raw);
  // CSV : caractères de tête invisibles et point-virgule
  assert.equal(csvCell('\u0000=1+1'), "'\u0000=1+1"); assert.equal(csvCell('\u200b=1+1'), "'\u200b=1+1"); assert.equal(csvCell('\u0001@x'), "'\u0001@x");
  assert.equal(csvCell('a;=1+1'), '"a;=1+1"');
}
function round(n) { return Math.round(n * 100) / 100; }

// ---------- Lecture seule : aucun solde modifié ----------
{
  // Aucun chargeur ne reçoit de moyen d'écriture ; les données sont gelées : toute mutation lèverait.
  const deep = (o) => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deep); } return o; };
  deep(store);
  const before = JSON.stringify(store);
  await get({ type: 'minutes', limit: '200' }); await get({ type: 'tokens', limit: '200' });
  await get({ type: 'minutes' }, undefined, 'exportCsv'); await get({ type: 'tokens' }, undefined, 'exportCsv');
  assert.equal(JSON.stringify(store), before);
  // Garde statique : ni le contrôleur, ni le service, ni les routes ne contiennent d'opération d'écriture ni d'appel qui débite/crédite.
  const forbidden = /\.(save|create|insert|insertOne|insertMany|update|updateOne|updateMany|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findByIdAndUpdate|remove|drop|aggregate|deleteOne|deleteMany|bulkWrite|replaceOne|syncMinutesFromCalls|ensurePlanMinutesGranted|ensurePlanTokensGranted)\b|\$inc\b|\$out\b|\$merge\b|\$set\b|\$push\b|\$addToSet\b/;
  for (const f of ['../controllers/consumptionJournalController.js', '../services/consumptionJournal.js', '../routes/billing.js']) {
    const src = fs.readFileSync(path.join(here, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n').replace(/createHash\('sha256'\)\.update\(/g, '');
    assert.ok(!forbidden.test(src), `${f} contient une opération d'écriture`);
  }
}

// ---------- Routes : authentification obligatoire ----------
{
  const src = fs.readFileSync(path.join(here, '../routes/billing.js'), 'utf8');
  assert.match(src, /router\.get\('\/consumption-journal', authenticate,/);
  assert.match(src, /router\.get\('\/consumption-journal\/export\.csv', authenticate,/);
  assert.equal((src.match(/router\.(get|post|put|patch|delete)\(/g) || []).length, 2, 'lecture seule : exactement deux routes GET');
  const index = fs.readFileSync(path.join(here, '../../index.js'), 'utf8');
  assert.match(index, /app\.use\('\/api\/billing', billingRoutes\)/);
}

console.log('consumptionJournal.test.js : OK');
