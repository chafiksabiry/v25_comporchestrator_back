// Run: node src/tests/inboundFlow.test.js
import assert from 'node:assert/strict';
import { buildInboundTwiml, buildNoAnswerTwiml, buildVoicemailDoneTwiml, xmlEscape, pollyVoice, DEFAULT_VOICEMAIL_PROMPT } from '../services/inboundFlow.js';
import { toPublicSettings } from '../services/inboundSettings.js';

const base = 'https://orch.test';
const companyId = '64b0000000000000000000c1';
const resultUrl = `${base}/api/phone-numbers/webhooks/twilio/inbound-dial-result`;
const common = { baseUrl: base, companyId, from: '+33612345678', resultUrl };
const audio = (text, voice) => ({ data: true, text, voice, version: 'abc123def456' });

// Sans réglage + conseillers : identique à l'ancien comportement (timeout 30, aucun accueil).
assert.equal(
  buildInboundTwiml({ ...common, settings: null, identities: ['cc-u1', 'cc-u2'] }),
  `<Dial timeout="30" answerOnBridge="true" action="${resultUrl}" method="POST" callerId="+33612345678"><Client>cc-u1</Client><Client>cc-u2</Client></Dial>`
);

// Délai de sonnerie paramétré
assert.match(buildInboundTwiml({ ...common, settings: { ringTimeoutSeconds: 45 }, identities: ['cc-u1'] }), /<Dial timeout="45" /);

// Accueil : voix de synthèse selon le genre de la voix
const t1 = buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour', voice: 'onyx' }, identities: ['cc-u1'] });
assert.ok(t1.startsWith('<Say language="fr-FR" voice="Polly.Mathieu">Bonjour</Say><Dial'));
assert.ok(buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour', voice: 'shimmer' }, identities: ['cc-u1'] }).includes('Polly.Lea'));
assert.equal(pollyVoice('coral'), 'Polly.Lea');
assert.equal(pollyVoice('ash'), 'Polly.Mathieu');

// Accueil : audio validé => Play ; texte modifié depuis => Say
const validated = { greetingText: 'Bonjour', voice: 'nova', greetingAudio: audio('Bonjour', 'nova') };
assert.ok(buildInboundTwiml({ ...common, settings: validated, identities: ['cc-u1'] }).startsWith(`<Play>${base}/api/inbound-settings/audio/${companyId}/greeting/abc123def456.mp3</Play><Dial`));
const stale = { ...validated, greetingText: 'Bonsoir' };
assert.ok(buildInboundTwiml({ ...common, settings: stale, identities: ['cc-u1'] }).startsWith('<Say '));
const otherVoice = { ...validated, voice: 'onyx' };
assert.ok(buildInboundTwiml({ ...common, settings: otherVoice, identities: ['cc-u1'] }).startsWith('<Say '));

// Pas de conseiller, répondeur activé par défaut : invitation par défaut + Record complet
const noAgent = buildInboundTwiml({ ...common, settings: null, identities: [] });
assert.ok(noAgent.includes(DEFAULT_VOICEMAIL_PROMPT.replace("'", '&apos;')));
assert.ok(noAgent.endsWith('<Record maxLength="120" timeout="5" playBeep="true" trim="trim-silence" action="https://orch.test/api/phone-numbers/webhooks/twilio/voicemail-done" method="POST" recordingStatusCallback="https://orch.test/api/phone-numbers/webhooks/twilio/voicemail-recording" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST"/>'));
assert.ok(!noAgent.includes('<Dial'));

// Invitation du répondeur : audio validé, texte personnalisé
const vmAudio = { voicemailText: 'Laissez un mot', voice: 'nova', voicemailAudio: audio('Laissez un mot', 'nova') };
assert.ok(buildInboundTwiml({ ...common, settings: vmAudio, identities: [] }).startsWith(`<Play>${base}/api/inbound-settings/audio/${companyId}/voicemail/abc123def456.mp3</Play><Record`));
assert.ok(buildInboundTwiml({ ...common, settings: { voicemailText: 'Laissez un mot' }, identities: [] }).includes('>Laissez un mot</Say><Record'));
// accueil + invitation
assert.ok(buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour' }, identities: [] }).startsWith('<Say language="fr-FR" voice="Polly.Lea">Bonjour</Say><Say'));

// Répondeur désactivé : message actuel + raccrochage
assert.equal(
  buildInboundTwiml({ ...common, settings: { voicemailEnabled: false }, identities: [] }),
  '<Say language="fr-FR" voice="Polly.Lea">Cette ligne est active sur la plateforme Harx. Aucun conseiller n&apos;est disponible pour le moment. Au revoir.</Say><Hangup/>'
);

// Échappement XML de tout texte inséré
assert.equal(xmlEscape(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
const evil = buildInboundTwiml({ ...common, settings: { greetingText: '</Say><Hangup/><Say>' }, identities: ['cc-u1'] });
assert.ok(!evil.includes('</Say><Hangup/>'));
assert.ok(evil.includes('&lt;/Say&gt;&lt;Hangup/&gt;'));

// Après la sonnerie
const na = (dialStatus, settings = null) => buildNoAnswerTwiml({ baseUrl: base, companyId, dialStatus, settings });
for (const st of ['no-answer', 'busy', 'failed']) assert.ok(na(st).includes('<Record '), st);
assert.equal(na('canceled'), '<Hangup/>', "l'appelant a raccroché : rien à enregistrer");
assert.equal(na('completed'), '<Hangup/>');
assert.equal(na('answered'), '<Hangup/>');
assert.equal(
  na('no-answer', { voicemailEnabled: false }),
  '<Say language="fr-FR" voice="Polly.Lea">Aucun conseiller n&apos;a pu répondre. Veuillez rappeler plus tard. Au revoir.</Say><Hangup/>'
);
assert.ok(!na('no-answer', { greetingText: 'Bonjour' }).includes('Bonjour'), "l'accueil n'est pas rejoué");

// Remerciement
assert.equal(buildVoicemailDoneTwiml(), '<Say language="fr-FR" voice="Polly.Lea">Merci, votre message a bien été enregistré. Au revoir.</Say><Hangup/>');

// settings déjà publics acceptés
assert.ok(buildInboundTwiml({ ...common, settings: toPublicSettings(validated), identities: [] }).includes('greeting/abc123def456.mp3'));
console.log('inboundFlow OK');
