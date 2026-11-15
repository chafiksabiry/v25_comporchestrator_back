// Run: JWT_SECRET=t node --test src/tests/labelsAdditive.test.js
// Lot 3e-1 (libellés) : champs ADDITIFS (clé ISO + libellé anglais des pays ; libellé anglais et paramètres des disponibilités et des résultats de transfert).
// Les champs d'origine (name, label, resultLabel…) restent EXACTEMENT ceux d'avant.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
const D = await import('../services/outboundDestinations.js');
const T = await import('../services/callTransfer.js');

test('pays : chaque entrée garde prefix / name et gagne iso (ISO 3166-1) et nameEn', () => {
  assert.equal(D.COUNTRY_CATALOG.length, 194);
  assert.deepEqual(Object.keys(D.COUNTRY_LABELS_EN).sort(), D.COUNTRY_CATALOG.map((c) => c.prefix).sort(), 'un libellé par indicatif, aucun en trop');
  const seen = new Set();
  for (const c of D.COUNTRY_CATALOG) {
    assert.match(c.prefix, /^\+\d{1,3}$/);
    assert.ok(typeof c.name === 'string' && c.name.length > 1, `nom français conservé : ${c.prefix}`);
    assert.ok(Array.isArray(c.iso) && c.iso.length >= 1, c.prefix);
    for (const code of c.iso) { assert.match(code, /^[A-Z]{2}$/, `${c.prefix} ${code}`); assert.ok(!seen.has(code), `ISO en double : ${code}`); seen.add(code); }
    assert.ok(typeof c.nameEn === 'string' && c.nameEn.length > 1, c.prefix);
    assert.equal(c.nameEn.split(' / ').length, c.iso.length, `${c.prefix} : un libellé par code ISO`);
  }
  // exemples vérifiés : champs d'origine inchangés
  const byPrefix = Object.fromEntries(D.COUNTRY_CATALOG.map((c) => [c.prefix, c]));
  assert.deepEqual([byPrefix['+33'].name, byPrefix['+33'].iso, byPrefix['+33'].nameEn], ['France', ['FR'], 'France']);
  assert.deepEqual([byPrefix['+1'].name, byPrefix['+1'].iso, byPrefix['+1'].nameEn], ['États-Unis / Canada', ['US', 'CA'], 'United States / Canada']);
  assert.deepEqual([byPrefix['+225'].name, byPrefix['+225'].iso, byPrefix['+225'].nameEn], ['Côte d’Ivoire', ['CI'], 'Côte d’Ivoire']);
  assert.deepEqual([byPrefix['+243'].name, byPrefix['+243'].iso, byPrefix['+243'].nameEn], ['RD Congo', ['CD'], 'DR Congo']);
  assert.deepEqual([byPrefix['+262'].name, byPrefix['+262'].iso], ['La Réunion / Mayotte', ['RE', 'YT']]);
});

test('pays : le libellé anglais correspond au nom CLDR de l\'ISO (contrôle croisé, hors noms usuels choisis)', () => {
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const usual = new Set(['CD', 'CG', 'CZ', 'MM', 'TL', 'MK', 'PS', 'KR', 'KP', 'ST', 'SZ', 'CV', 'FK', 'RE', 'CW', 'BQ', 'US', 'GB', 'HK', 'MO', 'CI']);
  let checked = 0;
  for (const c of D.COUNTRY_CATALOG) {
    const parts = c.nameEn.split(' / ');
    c.iso.forEach((code, i) => {
      const cldr = dn.of(code);
      if (!cldr || cldr === code || usual.has(code)) return; // ICU sans données pour ce code : ignoré
      assert.equal(parts[i], cldr, `${c.prefix} ${code}`);
      checked += 1;
    });
  }
  assert.ok(checked > 100, `contrôle croisé sur ${checked} pays`);
});

test('pays : validatePrefixList et le reste de la logique ne changent pas (le catalogue sert toujours de liste d\'indicatifs)', () => {
  assert.equal(D.validatePrefixList(['+33', '+1']).ok, true);
  assert.deepEqual(D.validatePrefixList(['+33', '+1']).value, ['+1', '+33'], 'ordre du catalogue');
  assert.equal(D.validatePrefixList(['+999']).ok, false);
});

test('disponibilité d\'une fiche de transfert : label français inchangé ; labelEn, params et reason additifs', () => {
  const hours = [{ day: 1, start: '09:00', end: '12:00' }, { day: 1, start: '14:00', end: '18:00' }];
  const mon = (hhmm) => Date.parse(`2026-11-02T${hhmm}:00+01:00`);
  const e = { name: 'Mme Martin', userId: 'u1', hours };
  const abs = [{ userId: 'u1', kind: 'leave', startDate: '2026-11-01', endDate: '2026-11-06' }];
  let a = T.entryAvailability(e, [], mon('10:00'));
  assert.deepEqual(a, { state: 'available', label: 'Disponible jusqu’à 12 h.', labelEn: 'Available until 12:00.', params: { until: '12:00' } });
  a = T.entryAvailability(e, [], mon('13:00'));
  assert.deepEqual(a, { state: 'later', label: 'Pas encore là : disponible à partir de 14 h.', labelEn: 'Not here yet: available from 14:00.', params: { from: '14:00' } });
  a = T.entryAvailability(e, [], mon('19:00'));
  assert.deepEqual(a, { state: 'off', reason: 'past_hours', label: 'Plus disponible aujourd’hui.', labelEn: 'No longer available today.', params: {} });
  a = T.entryAvailability(e, [], Date.parse('2026-11-03T10:00:00+01:00'));
  assert.deepEqual(a, { state: 'off', reason: 'no_slot_today', label: 'Pas de présence prévue aujourd’hui.', labelEn: 'No presence scheduled today.', params: {} });
  a = T.entryAvailability({ name: 'X', hours: [] }, [], mon('10:00'));
  assert.deepEqual(a, { state: 'unknown', label: 'Horaires non précisés.', labelEn: 'Hours not specified.', params: {} });
  a = T.entryAvailability(e, abs, mon('10:00'));
  assert.deepEqual(a, { state: 'absent', label: 'Mme Martin est absent·e jusqu’au 06/11/2026.', labelEn: 'Mme Martin is away until 2026-11-06.', params: { name: 'Mme Martin', until: '2026-11-06' } });
});

test('journal des transferts : resultLabel inchangé, resultLabelEn additif pour chaque résultat', () => {
  assert.deepEqual(Object.keys(T.RESULT_LABEL_EN).sort(), Object.keys(T.RESULT_LABEL).sort(), 'un libellé anglais par résultat');
  for (const result of Object.keys(T.RESULT_LABEL)) {
    const log = T.toTransferLog({ _id: 'c1', callSid: 'CA1', from: '+33611', transfer: { result, entryName: 'X' } });
    assert.equal(log.resultLabel, T.RESULT_LABEL[result]);
    assert.equal(log.resultLabelEn, T.RESULT_LABEL_EN[result]);
    assert.ok(!/[àâçéèêëîïôùûü]/i.test(log.resultLabelEn), result);
  }
  const unknown = T.toTransferLog({ _id: 'c2', callSid: 'CA2', transfer: {} });
  assert.deepEqual([unknown.resultLabel, unknown.resultLabelEn], ['En cours', 'In progress']);
});
