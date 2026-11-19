// Run: node --test src/tests/noCommittedSecrets.test.js
// Aucun identifiant réel ne doit être committé : URI de base avec mot de passe, clés Stripe live/test, secrets de webhook, clés privées. Les secrets
// viennent de l'environnement. Le test ne contient et n'affiche JAMAIS de valeur : il signale fichier:ligne:type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', '.git', 'package-lock.json', 'noCommittedSecrets.test.js']);
const PATTERNS = [
  ['uri-base-avec-mot-de-passe', /mongodb(\+srv)?:\/\/[^\s'"<>$:@/]+:[^\s'"<>$@]+@/],
  ['cle-stripe', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/],
  ['secret-webhook-stripe', /\bwhsec_[A-Za-z0-9]{10,}/],
  ['cle-privee', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jeton-github', /\bghp_[A-Za-z0-9]{20,}/],
  ['cle-aws', /\bAKIA[0-9A-Z]{16}\b/],
];
function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else if (/\.(js|mjs|cjs|json|md|ya?ml|env|sh|txt|example)$/.test(e.name) || e.name.startsWith('.env')) yield p;
  }
}

test('aucun identifiant committé (URI de base avec mot de passe, clé Stripe, secret de webhook, clé privée)', () => {
  const found = [];
  for (const f of files(ROOT)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      for (const [type, re] of PATTERNS) if (re.test(line)) found.push(`${path.relative(ROOT, f)}:${i + 1}:${type}`);
    });
  }
  assert.deepEqual(found, [], `identifiants committés (valeurs masquées) : ${found.join(', ')}`);
});
