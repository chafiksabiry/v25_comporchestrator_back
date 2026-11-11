import assert from 'node:assert/strict';
import { mapTwilioCallStatus, isTwilioMachineAnswer } from '../services/twilioTestCallStatus.js';

assert.equal(isTwilioMachineAnswer('machine_start'), true);
assert.equal(isTwilioMachineAnswer('human'), false);
assert.equal(isTwilioMachineAnswer('unknown'), false);
assert.equal(isTwilioMachineAnswer(''), false);

// Décroché au sens de l'opérateur : jamais coupé sur le seul soupçon de répondeur, on attend la touche 1.
const wait = mapTwilioCallStatus('in-progress', { answeredBy: 'machine_start' });
assert.equal(wait.status, 'ringing');
assert.equal(wait.outcome, null);
assert.equal(wait.reachedActive, false);

// La touche 1 prouve une personne, même si la détection avait soupçonné un répondeur.
const confirmed = mapTwilioCallStatus('in-progress', { answeredBy: 'machine_start', humanConfirmed: true });
assert.equal(confirmed.status, 'active');
assert.equal(confirmed.reachedActive, true);
const done = mapTwilioCallStatus('completed', { answeredBy: 'machine_start', humanConfirmed: true, duration: 15 });
assert.deepEqual([done.status, done.outcome, done.reachedActive], ['ended', 'completed', true]);

// Un vrai répondeur laisse dérouler le message en entier.
const voicemail = mapTwilioCallStatus('completed', { answeredBy: 'machine_start', duration: 32, prev: { reachedRinging: true } });
assert.deepEqual([voicemail.status, voicemail.outcome], ['ended', 'voicemail']);

// Raccroché très vite sans avoir appuyé sur 1 : ce n'est pas un répondeur.
const hungUp = mapTwilioCallStatus('completed', { answeredBy: 'machine_start', duration: 5, prev: { reachedRinging: true } });
assert.deepEqual([hungUp.status, hungUp.outcome, hungUp.reachedActive], ['ended', 'unconfirmed', false]);
const hungUpHuman = mapTwilioCallStatus('completed', { answeredBy: 'human', duration: 6, prev: { reachedRinging: true } });
assert.equal(hungUpHuman.outcome, 'unconfirmed');

// Sans durée connue, le comportement d'origine est conservé.
assert.equal(mapTwilioCallStatus('completed', { answeredBy: 'machine_start', prev: { reachedRinging: true } }).outcome, 'voicemail');
assert.equal(mapTwilioCallStatus('completed', { prev: { reachedRinging: true } }).outcome, 'no-answer');
assert.equal(mapTwilioCallStatus('completed', {}).outcome, 'failed');

// États simples inchangés.
assert.equal(mapTwilioCallStatus('queued').status, 'connecting');
assert.equal(mapTwilioCallStatus('ringing').status, 'ringing');
for (const s of ['busy', 'no-answer', 'canceled', 'failed']) assert.equal(mapTwilioCallStatus(s).outcome, s);

console.log('twilioTestCallStatus OK');
