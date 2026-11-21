// Run: node --test src/tests/callbackRefusalLanguage.test.js
// Rappel d'un message depuis le navigateur : les refus parlés au collaborateur suivent la langue de la ligne émettrice
// (+33 français exact, +44 anglais, ligne inconnue anglais). Base et opérateur simulés.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { register } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
try { import.meta.resolve('web-push'); } catch {
  register('data:text/javascript,' + encodeURIComponent("export async function resolve(s,c,n){ if(s==='web-push') return {url:'data:text/javascript,export default {setVapidDetails(){},sendNotification(){}}',shortCircuit:true}; return n(s,c); }"));
}
mongoose.set('bufferCommands', false); // toute lecture non simulée échoue tout de suite (aucune base)

const L = await import('../services/companyLanguage.js');
const { default: Voicemail } = await import('../models/Voicemail.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
const { default: MinutesCompany } = await import('../models/MinutesCompany.js');
const { Subscription } = await import('../models/Subscription.js');
const { signTicket } = await import('../services/voicemailCallback.js');
const { voicemailController } = await import('../controllers/voicemailController.js');

const C1 = '64b0000000000000000000c1';
const VM = '64b0000000000000000000a1';
const IDENTITY = 'cc-owner1';
const q = (v) => { const c = { select: () => c, sort: () => c, lean: async () => v, populate: async () => v, then: (r, j) => Promise.resolve(v).then(r, j) }; return c; };

let vm; let lines; let minutes;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  vm = { _id: VM, companyId: C1, phoneNumber: '+33188732537', from: '+33612345678' };
  lines = [{ phoneNumber: '+33188732537', companyId: C1, provider: 'twilio', twilioId: 'PN1' }, { phoneNumber: '+442046522552', companyId: C1, provider: 'twilio', twilioId: 'PN2' }];
  minutes = 0;
  Voicemail.findById = () => q(vm);
  PhoneNumber.findOne = (f) => q(lines.find((l) => l.phoneNumber === f.phoneNumber) || null);
  MinutesCompany.findOne = () => q({ companyId: C1, minutes });
  MinutesCompany.create = async (d) => d;
  Subscription.findOne = () => q(null);
});
after(() => Object.assign(console, saved));

const callback = async ({ ticket } = {}) => {
  let out = null;
  const res = { type() { return res; }, status() { return res; }, send(x) { out = x; return res; } };
  const Ticket = ticket ?? signTicket({ secret: process.env.TWILIO_AUTH_TOKEN, voicemailId: VM, identity: IDENTITY });
  await voicemailController.callbackVoice({ body: { VoicemailId: VM, Ticket, From: `client:${IDENTITY}`, CallSid: '' }, get: () => 'orch.test' }, res);
  return out;
};
const said = (xml) => { const m = String(xml).match(/<Say language="([^"]+)" voice="([^"]+)">([^<]*)<\/Say><Hangup\/>/); return m ? { language: m[1], voice: m[2], text: m[3] } : null; };

test('preuve invalide : aucune ligne établie -> anglais', async () => {
  assert.deepEqual(said(await callback({ ticket: 'bad.sig' })), { language: 'en-US', voice: 'Polly.Joanna', text: 'Callback not authorized.' });
});

test('numéro impossible à rappeler : +33 français exact, +44 anglais', async () => {
  vm.from = '+33899123456'; // numéro surtaxé
  assert.deepEqual(said(await callback()), { language: 'fr-FR', voice: 'Polly.Lea', text: 'Impossible de rappeler ce numéro.' });
  vm.phoneNumber = '+442046522552';
  assert.deepEqual(said(await callback()), { language: 'en-US', voice: 'Polly.Joanna', text: 'This number cannot be called back.' });
});

test('ligne introuvable : langue du numéro de la ligne du message (+44 anglais)', async () => {
  vm.phoneNumber = '+442070000000'; // n'est plus une ligne de l'entreprise
  assert.equal(said(await callback()).text, 'This number cannot be called back.');
});

test('solde de minutes insuffisant (national) : +33 français exact (message historique), +44 anglais', async () => {
  minutes = 0;
  assert.deepEqual(said(await callback()), { language: 'fr-FR', voice: 'Polly.Lea', text: 'Solde de minutes insuffisant.' });
  vm.phoneNumber = '+442046522552'; vm.from = '+447700900123';
  assert.deepEqual(said(await callback()), { language: 'en-US', voice: 'Polly.Joanna', text: 'Insufficient minutes balance.' });
});

test('erreur inattendue après lecture de la ligne : langue de la ligne', async () => {
  vm.phoneNumber = '+442046522552'; vm.from = '+447700900123';
  MinutesCompany.findOne = () => { throw new Error('db down'); };
  assert.deepEqual(said(await callback()), { language: 'en-US', voice: 'Polly.Joanna', text: 'An error occurred.' });
  vm.phoneNumber = '+33188732537'; vm.from = '+33612345678';
  assert.equal(said(await callback()).text, 'Une erreur est survenue.');
});

test('les 8 langues : quatre refus présents', () => {
  for (const lang of L.COMPANY_LANGUAGES) for (const k of ['callbackNotAuthorized', 'callbackCannotCall', 'callbackInsufficientMinutes', 'callbackError']) assert.ok(L.PHRASES[lang][k]?.trim(), `${lang} ${k}`);
});
