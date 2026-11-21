// Run: node src/tests/messageSubject.test.js
// Objet de la notification d'un message pris dans la langue de l'entreprise (audit design du 21/11/2026, B5). Messagerie simulée.
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { messageSubject, notifyByMail, setNotifyDeps } = await import('../services/messageNotify.js');

// ---------------------------------------------------------------- objet seul
assert.equal(messageSubject({ callerName: 'Aziz SLASSI' }), 'Message from Aziz SLASSI', 'sans langue : anglais (langue par défaut, règle du 21/11)');
assert.equal(messageSubject({ callerName: 'Aziz SLASSI', language: 'fr', escalation: true, urgent: true }), 'RELANCE · URGENT · Message de Aziz SLASSI', 'français inchangé');
assert.equal(messageSubject({ callerName: 'Aziz SLASSI', language: 'en' }), 'Message from Aziz SLASSI');
assert.equal(messageSubject({ callerName: 'Aziz SLASSI', language: 'en', escalation: true, urgent: true }), 'REMINDER · URGENT · Message from Aziz SLASSI');
assert.equal(messageSubject({ callerName: 'Aziz SLASSI', language: 'es', urgent: true }), 'URGENTE · Mensaje de Aziz SLASSI');
assert.equal(messageSubject({ callerName: 'Aziz SLASSI', language: 'ar', escalation: true }), 'تذكير · رسالة من Aziz SLASSI');
assert.equal(messageSubject({ callerName: 'X', language: 'de' }), 'Nachricht von X');
assert.equal(messageSubject({ callerName: 'X', language: 'xx' }), 'Message from X', 'langue inconnue : anglais');
assert.equal(messageSubject({ callerName: 'Jean\r\nBcc: pirate@x', language: 'en' }), 'Message from Jean Bcc: pirate@x', 'aucun saut de ligne dans l’objet');
assert.equal(messageSubject({ callerName: 'A'.repeat(300), language: 'en' }).length, 150, '150 caractères au plus');

// ---------------------------------------------------------------- envoi : objet et journal dans la langue de la société
const sent = []; const logs = []; const asked = [];
const deps = (over = {}) => ({
  loadEmailIdentity: async () => ({ provider: 'google' }),
  resolveUserMailbox: async () => ({ kind: 'connection', provider: 'google', account: 'accueil@acme.test' }),
  loadUserProfile: async () => ({ name: 'Paul', email: 'paul@acme.test' }),
  sendViaMailbox: async (c, mailbox, msg) => { sent.push(msg); },
  countRecent: async () => 0, log: async (r) => { logs.push(r); return { _id: 'l' + logs.length, ...r }; }, saveContent: async () => {},
  companyLanguage: async (companyId) => { asked.push(companyId); return 'en'; },
  ...over,
});
const args = { companyId: '64b0000000000000000000c1', followUpId: 'f1', entry: { name: 'Paul', userId: 'u1', email: '' }, message: { callerName: 'Dupont', callerCompany: '', callerPhone: '', reason: 'Devis', urgency: 'urgent', callbackBefore: null }, takenBy: { id: 'a1', name: 'Léa' }, companyName: 'Acme', timeZone: 'Europe/Paris' };
setNotifyDeps(deps());
assert.equal(await notifyByMail(args), 'sent');
assert.equal(sent[0].subject, 'URGENT · Message from Dupont');
assert.equal(logs[0].subject, 'URGENT · Message from Dupont', 'le journal garde l’objet envoyé');
assert.deepEqual(asked, ['64b0000000000000000000c1'], 'langue lue pour la société de l’envoi');
// relance (messageReminders passe escalationFor)
setNotifyDeps(deps({ companyLanguage: async () => 'ar' }));
assert.equal(await notifyByMail({ ...args, message: { ...args.message, urgency: 'normal', escalationFor: 'Paul' } }), 'sent');
assert.equal(sent.at(-1).subject, 'تذكير · رسالة من Dupont'); assert.equal(logs.at(-1).template, 'message_escalation');
// langue illisible : anglais (langue par défaut), et l'envoi part quand même
setNotifyDeps(deps({ companyLanguage: async () => { throw new Error('base'); } }));
assert.equal(await notifyByMail(args), 'sent');
assert.equal(sent.at(-1).subject, 'URGENT · Message from Dupont');
// dépendances réelles (base non connectée) : anglais sans attendre la base
const { companyLanguage: _unused, ...noLang } = deps(); // eslint-disable-line no-unused-vars
setNotifyDeps(noLang);
const t0 = Date.now();
assert.equal(await notifyByMail(args), 'sent');
assert.ok(Date.now() - t0 < 2000, 'pas d’attente de la base');
assert.equal(sent.at(-1).subject, 'URGENT · Message from Dupont');
setNotifyDeps(null);
// langue transmise par l'appelant (prise du message, relance) : utilisée sans relire la base ; corps en français pour une société francophone
asked.length = 0;
setNotifyDeps(deps());
assert.equal(await notifyByMail({ ...args, language: 'fr' }), 'sent');
assert.equal(sent.at(-1).subject, 'URGENT · Message de Dupont'); assert.match(sent.at(-1).text, /^Bonjour Paul,/); assert.deepEqual(asked, []);
// société espagnole : objet en espagnol (#229), corps en anglais (staffTexts : fr ou en)
assert.equal(await notifyByMail({ ...args, language: 'es' }), 'sent');
assert.equal(sent.at(-1).subject, 'URGENTE · Mensaje de Dupont'); assert.match(sent.at(-1).text, /^Hello Paul,/);
setNotifyDeps(null);
console.log('messageSubject : OK');
