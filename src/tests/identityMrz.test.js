// Run: node --test src/tests/identityMrz.test.js
// Chiffres de clé MRZ (OACI Doc 9303) calculés par le code, sur les SPÉCIMENS publics de l'OACI (État fictif « UTO »).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDigit, mrzDate, parseMrz, mrzDocumentKind } from '../services/identity/mrz.js';
import { td1, td3 } from './identityFixtures.js';

const ICAO_TD3 = ['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'];
const ICAO_TD1 = ['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<'];

test('chiffre de clé : pondération 7-3-1, « < » = 0, lettres A=10', () => {
  assert.equal(checkDigit('L898902C3'), 6);
  assert.equal(checkDigit('740812'), 2);
  assert.equal(checkDigit('120415'), 9);
  assert.equal(checkDigit('<<<<<'), 0);
});

test('spécimen OACI TD3 (passeport) : valide, champs lus', () => {
  const r = parseMrz(ICAO_TD3);
  assert.equal(r.format, 'TD3');
  assert.equal(r.valid, true);
  assert.deepEqual(r.checks, { documentNumber: true, birthDate: true, expiryDate: true, optional: true, composite: true });
  assert.equal(r.issuingState, 'UTO');
  assert.equal(r.nationality, 'UTO');
  assert.equal(r.lastName, 'ERIKSSON');
  assert.equal(r.givenNames, 'ANNA MARIA');
  assert.equal(r.documentNumber, 'L898902C3');
  assert.equal(mrzDocumentKind(r.documentCode), 'passport');
});

test('spécimen OACI TD1 (carte) : valide', () => {
  const r = parseMrz(ICAO_TD1);
  assert.equal(r.format, 'TD1');
  assert.equal(r.valid, true);
  assert.equal(r.lastName, 'ERIKSSON');
});

test('date d’expiration modifiée (2012 -> 2015) : chiffres de clé faux, MRZ invalide', () => {
  const r = parseMrz(['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1504159ZE184226B<<<<<10']);
  assert.equal(r.valid, false);
  assert.equal(r.checks.expiryDate, false);
  assert.equal(r.checks.composite, false);
});

test('numéro de document retouché : détecté', () => {
  const r = parseMrz(['P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C46UTO7408122F1204159ZE184226B<<<<<10']);
  assert.equal(r.valid, false);
  assert.equal(r.checks.documentNumber, false);
});

test('TD2 (2 × 36) construit sur le spécimen : valide, et une altération est détectée', () => {
  const l2 = td3({ issuing: 'UTO' })[1];
  // TD2 : mêmes champs que TD3 sur 36 caractères (facultatif de 7), composite recalculé.
  const num = 'L898902C3'; const body = `${num}${checkDigit(num)}UTO7408122F1204159${'<'.repeat(7)}`;
  const composite = checkDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21, 35));
  const lines = ['I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<', body + composite];
  assert.ok(l2.length === 44);
  assert.equal(parseMrz(lines).format, 'TD2');
  assert.equal(parseMrz(lines).valid, true);
  assert.equal(parseMrz([lines[0], lines[1].replace('7408122', '7408132')]).valid, false);
});

test('lignes mal formées : jamais valides (aucune correction O/0)', () => {
  assert.equal(parseMrz([]).valid, false);
  assert.equal(parseMrz(['abc', 'def']).format, null);
  assert.equal(parseMrz([ICAO_TD3[0], ICAO_TD3[1].replace('0', 'O')]).valid, false);
  assert.equal(parseMrz([ICAO_TD3[0], `${ICAO_TD3[1].slice(0, 20)}é${ICAO_TD3[1].slice(21)}`]).valid, false);
});

test('espaces recopiés par le lecteur : ignorés', () => {
  assert.equal(parseMrz([ICAO_TD3[0].replace('<<ANNA', '<< ANNA'), ` ${ICAO_TD3[1]} `]).valid, true);
});

test('dates MRZ : siècle de naissance dans le passé, expiration dans le futur', () => {
  const now = new Date('2026-11-22T00:00:00Z');
  assert.equal(mrzDate('740812', { now }).toISOString().slice(0, 10), '1974-08-12');
  assert.equal(mrzDate('120415', { future: true, now }).toISOString().slice(0, 10), '2012-04-15');
  assert.equal(mrzDate('310415', { future: true, now }).toISOString().slice(0, 10), '2031-04-15');
  assert.equal(mrzDate('990231', { now }), null);
});

test('constructeurs de spécimens : TD1 et TD3 valides', () => {
  assert.equal(parseMrz(td1({ issuing: 'FRA' })).valid, true);
  assert.equal(parseMrz(td3({ issuing: 'MAR' })).valid, true);
  assert.equal(mrzDocumentKind('IR'), 'residence_permit');
  assert.equal(mrzDocumentKind('ID'), 'id_card');
});

// ---------------- Tolérances (23/11) : toujours vérifiées par les chiffres de clé ----------------
const [L1, L2] = ICAO_TD3;

test('tolérance : espaces et chevrons typographiques retirés ; passeport TD3 2 × 44', () => {
  const r = parseMrz([L1.replace(/</g, ' < ').replace('P', 'P '), `${L2.slice(0, 20)} ${L2.slice(20)}`]);
  assert.equal(r.valid, true);
  assert.equal(parseMrz([L1.replace(/<</, '«<'), L2]).valid, true);
});

test('tolérance : chevrons de remplissage mal comptés (ligne des noms, données facultatives)', () => {
  // Ligne 1 : chevrons de fin oubliés ou en trop.
  assert.equal(parseMrz([L1.slice(0, 40), L2]).valid, true);
  assert.equal(parseMrz([`${L1}<<`, L2]).valid, true);
  // Ligne 2 : suite « <<<<< » des données facultatives comptée 4 ou 6 fois : réajustée, les chiffres de clé confirment.
  const r = parseMrz([L1, L2.replace('B<<<<<10', 'B<<<<10')]);
  assert.equal(r.valid, true);
  assert.equal(r.repaired, true);
  assert.equal(r.documentNumber, 'L898902C3');
  assert.equal(parseMrz([L1, L2.replace('B<<<<<10', 'B<<<<<<10')]).valid, true);
});

test('tolérance : O lu à la place de 0 dans une date ou un chiffre de clé ; 0 à la place de O dans un code pays', () => {
  assert.equal(parseMrz([L1, L2.replace('7408122F1204159', '74O8122F12O4159')]).valid, true);
  assert.equal(parseMrz([L1.replace('UTO', 'UT0'), L2]).valid, true);
  // Jamais dans le numéro de document (alphanumérique) : une confusion là reste une erreur.
  assert.equal(parseMrz([L1, L2.replace('L898902C3', 'L8989O2C3')]).valid, false);
});

test('tolérance sans effet sur une vraie erreur : date retouchée, chiffre de clé faux -> toujours invalide', () => {
  const r = parseMrz([L1.slice(0, 41), 'L898902C36UTO7408122F1504159ZE184226B<<<<10']);
  assert.equal(r.format, 'TD3');
  assert.equal(r.valid, false);
  assert.equal(parseMrz([L1, L2.slice(0, 30)]).valid, false);
});

test('ancienne carte d’identité française 2 × 36 (spécimen public) : reconnue, chiffres de clé corrects, nationalité FRA', () => {
  const cni = ['IDFRADOUEL<<<<<<<<<<<<<<<<<<<<932013', '0506932020438CHRISTIANE<<NI2906209F3'];
  const r = parseMrz(cni);
  assert.equal(r.format, 'FR_CNI');
  assert.equal(r.valid, true);
  assert.deepEqual(r.checks, { documentNumber: true, birthDate: true, composite: true });
  assert.equal(r.lastName, 'DOUEL');
  assert.equal(r.givenNames, 'CHRISTIANE NI');
  assert.equal(r.nationality, 'FRA');
  assert.equal(r.birthDate, '290620');
  assert.equal(r.expiryDate, null);
  assert.equal(mrzDocumentKind(r.documentCode), 'id_card');
  // Chiffre de clé du numéro faux : invalide ; chevrons du nom mal comptés : réparés.
  assert.equal(parseMrz([cni[0], cni[1].replace('0506932020438', '0506932020439')]).valid, false);
  assert.equal(parseMrz([cni[0].replace('DOUEL<<<<', 'DOUEL<<<'), cni[1]]).valid, true);
  // Un vrai TD2 de 36 caractères reste lu en TD2.
  assert.notEqual(parseMrz(['I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<', 'D231458907UTO7408122F1204159<<<<<<<6']).format, 'FR_CNI');
});
