// Run: node src/tests/inboundFlow.test.js
import assert from 'node:assert/strict';
import { greetingTwiml, buildInboundTwiml, buildNoAnswerTwiml, buildVoicemailDoneTwiml, xmlEscape, pollyVoice, DEFAULT_VOICEMAIL_PROMPT, SOLO_VOICEMAIL_PROMPT, SOLO_NO_ANSWER_MESSAGE, SOLO_NO_AGENT_MESSAGE } from '../services/inboundFlow.js';
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
assert.ok(t1.startsWith('<Say language="fr-FR" voice="Polly.Remi-Neural">Bonjour</Say><Dial'));
assert.ok(buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour', voice: 'shimmer' }, identities: ['cc-u1'] }).includes('Polly.Lea-Generative'));
assert.equal(pollyVoice('coral'), 'Polly.Lea-Generative');
assert.equal(pollyVoice('ash'), 'Polly.Remi-Neural');

// Accueil désactivé : l'appel entre directement (ni texte ni audio), la sonnerie est inchangée
const off = buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour', voice: 'onyx', greetingEnabled: false }, identities: ['cc-u1'] });
assert.ok(off.startsWith('<Dial') && !off.includes('Bonjour'), 'accueil désactivé : pas de Say');
assert.ok(buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour', greetingEnabled: false, greetingAudio: audio('Bonjour', 'nova') }, identities: ['cc-u1'] }).startsWith('<Dial'), 'accueil désactivé : pas de Play non plus');
assert.equal(greetingTwiml({ greetingText: 'Bonjour', greetingEnabled: false }, base, companyId), '', 'files d\'attente : pas d\'accueil avant le menu');
assert.ok(greetingTwiml({ greetingText: 'Bonjour' }, base, companyId).includes('Bonjour'), 'activé par défaut');

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
assert.ok(buildInboundTwiml({ ...common, settings: { greetingText: 'Bonjour' }, identities: [] }).startsWith('<Say language="fr-FR" voice="Polly.Lea-Generative">Bonjour</Say><Say'));

// Répondeur désactivé : message actuel + raccrochage
assert.equal(
  buildInboundTwiml({ ...common, settings: { voicemailEnabled: false }, identities: [] }),
  '<Say language="fr-FR" voice="Polly.Lea-Generative">Cette ligne est active sur la plateforme Harx. Aucun conseiller n&apos;est disponible pour le moment. Au revoir.</Say><Hangup/>'
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
  '<Say language="fr-FR" voice="Polly.Lea-Generative">Aucun conseiller n&apos;a pu répondre. Veuillez rappeler plus tard. Au revoir.</Say><Hangup/>'
);
assert.ok(!na('no-answer', { greetingText: 'Bonjour' }).includes('Bonjour'), "l'accueil n'est pas rejoué");

// Remerciement
assert.equal(buildVoicemailDoneTwiml(), '<Say language="fr-FR" voice="Polly.Lea-Generative">Merci, votre message a bien été enregistré. Au revoir.</Say><Hangup/>');

// settings déjà publics acceptés
assert.ok(buildInboundTwiml({ ...common, settings: toPublicSettings(validated), identities: [] }).includes('greeting/abc123def456.mp3'));

// Variante Nomad Solo : texte à la première personne ; l'entreprise garde les textes actuels.
const esc = (t) => t.replace(/'/g, '&apos;');
const soloVm = buildInboundTwiml({ ...common, settings: null, identities: [], solo: true });
assert.ok(soloVm.includes(esc(SOLO_VOICEMAIL_PROMPT)) && !soloVm.includes('conseiller'));
assert.ok(buildInboundTwiml({ ...common, settings: { voicemailText: 'Laissez un mot' }, identities: [], solo: true }).includes('>Laissez un mot</Say><Record'), 'le texte personnalisé prime');
const soloNoAgent = buildInboundTwiml({ ...common, settings: { voicemailEnabled: false }, identities: [], solo: true });
assert.ok(soloNoAgent.includes(esc(SOLO_NO_AGENT_MESSAGE)) && !soloNoAgent.includes('Harx') && !soloNoAgent.includes('conseiller'));
const soloNa = buildNoAnswerTwiml({ baseUrl: base, companyId, dialStatus: 'no-answer', settings: { voicemailEnabled: false }, solo: true });
assert.ok(soloNa.includes(esc(SOLO_NO_ANSWER_MESSAGE)) && !soloNa.includes('conseiller'));
assert.ok(buildNoAnswerTwiml({ baseUrl: base, companyId, dialStatus: 'no-answer', settings: null, solo: true }).includes(esc(SOLO_VOICEMAIL_PROMPT)));
assert.ok(buildNoAnswerTwiml({ baseUrl: base, companyId, dialStatus: 'no-answer', settings: { voicemailEnabled: false } }).includes('Aucun conseiller n&apos;a pu répondre'), 'entreprise : texte inchangé');
console.log('inboundFlow OK');
