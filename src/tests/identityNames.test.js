// Run: node --test src/tests/identityNames.test.js
// Comparaison des noms par le code : accents, ordre, deuxième prénom, translittération arabe (noms fictifs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareNames, compareFullName, compareReadToRead, normalize, skeleton } from '../services/identity/names.js';

test('cas de l’annexe de la spécification', () => {
  const cases = [
    [{ firstName: 'Anna', lastName: 'Eriksson' }, { firstName: 'ANNA MARIA', lastName: 'ERIKSSON' }, 'match'],
    [{ firstName: 'Hélène', lastName: 'Le Bœuf' }, { firstName: 'HELENE', lastName: 'LE BOEUF' }, 'match'],
    [{ firstName: 'Marie', lastName: 'Dupont' }, { firstName: 'DUPONT', lastName: 'MARIE' }, 'match'],
    [{ firstName: 'Mohamed', lastName: 'El Amrani' }, { firstName: 'MOHAMMED', lastName: 'ELAMRANI' }, 'review'],
    [{ firstName: 'Youssef', lastName: 'Benali' }, { firstName: 'YOUSSEF', lastName: 'BEN ALI' }, 'review'],
    [{ firstName: 'Anna', lastName: 'Eriksson' }, { firstName: 'PAUL', lastName: 'MARTIN' }, 'mismatch'],
  ];
  for (const [e, r, want] of cases) assert.equal(compareNames(e, r), want, JSON.stringify([e, r]));
});

test('normalisation : majuscules, accents, ligatures, séparateurs', () => {
  assert.equal(normalize('Jean-Éloïse d’Arc'), 'JEAN ELOISE D ARC');
  assert.equal(normalize('Strauß'), 'STRAUSS');
  assert.equal(skeleton('MOHAMMED'), skeleton('MOHAMED'));
});

test('nom complet enregistré (un seul champ) : découpage ambigu géré', () => {
  assert.equal(compareFullName('Anna Eriksson', { firstName: 'ANNA MARIA', lastName: 'ERIKSSON' }), 'match');
  assert.equal(compareFullName('Anna Maria Eriksson', { firstName: 'ANNA MARIA', lastName: 'ERIKSSON' }), 'match');
  assert.equal(compareFullName('Youssef El Amrani', { firstName: 'YOUSSEF', lastName: 'EL AMRANI' }), 'match');
  assert.equal(compareFullName('Youssef El Amrani', { firstName: 'YOUSSEF', lastName: 'ELAMRANI' }), 'review');
  assert.equal(compareFullName('Anna Eriksson', { firstName: 'PAUL', lastName: 'MARTIN' }), 'mismatch');
  // Jamais « match » sur un nom vide ou un seul mot.
  assert.equal(compareFullName('Anna', { firstName: 'ANNA', lastName: 'ERIKSSON' }), 'review');
  assert.equal(compareFullName('Anna Eriksson', { firstName: '', lastName: '' }), 'review');
});

test('justificatif <-> pièce : civilité tolérée, autre personne détectée', () => {
  assert.equal(compareReadToRead({ firstName: 'ANNA MARIA', lastName: 'ERIKSSON' }, 'Mme Anna Eriksson'), 'match');
  assert.equal(compareReadToRead({ firstName: 'YOUSSEF', lastName: 'ELAMRANI' }, 'Youssef Elamrani'), 'match');
  assert.equal(compareReadToRead({ firstName: 'ANNA', lastName: 'ERIKSSON' }, 'Paul Eriksson'), 'mismatch');
  assert.equal(compareReadToRead({ firstName: 'ANNA', lastName: 'ERIKSSON' }, ''), 'review');
});
