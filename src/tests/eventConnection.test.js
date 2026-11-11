// Run: JWT_SECRET=test node src/tests/eventConnection.test.js
import assert from 'node:assert/strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.INTEGRATIONS_ENC_KEY = 'ab'.repeat(32);

const C = await import('../services/secretariatProviders/eventConnection.js');
const { google } = await import('../services/secretariatProviders/google.js');
const { microsoft } = await import('../services/secretariatProviders/microsoft.js');
const { publicEvent } = await import('../services/secretariatSharedAccounts.js');

// ---------- liens : seulement https et un service de visio connu
assert.equal(C.safeVideoUrl('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
assert.equal(C.safeVideoUrl('https://us02web.zoom.us/j/12345678901?pwd=abc'), 'https://us02web.zoom.us/j/12345678901?pwd=abc');
assert.equal(C.safeVideoUrl('http://meet.google.com/abc-defg-hij'), '', 'pas de http');
assert.equal(C.safeVideoUrl('https://evil.example/zoom.us/j/1'), '', 'pas un hôte de visio');
assert.equal(C.safeVideoUrl('https://meet.google.com.evil.example/x'), '', 'faux sous-domaine refusé');
assert.equal(C.safeVideoUrl('https://user:pw@zoom.us/j/12345678'), '', 'pas d’identifiants dans le lien');
assert.equal(C.safeVideoUrl('javascript:alert(1)'), '');
assert.equal(C.videoUrlIn('Salle 3', 'Rejoindre : https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1.'), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=1', 'point final retiré');
assert.equal(C.videoUrlIn('Bureau', 'voir https://example.com/info'), '');

// ---------- numéros d'appel
assert.deepEqual(C.dialIn('+1 650-555-0100', '123 456#'), { label: '+1 650-555-0100', uri: 'tel:+16505550100', pin: '123456#' });
assert.equal(C.dialIn('pas un numéro', '1'), null);
assert.equal(C.dialIn('tel:+33123456789', '').uri, 'tel:+33123456789');

// ---------- description : texte brut, limité
assert.equal(C.plainDescription('<p>Bonjour<br>à tous</p>'), 'Bonjour\nà tous');
assert.ok(C.plainDescription('x'.repeat(5000)).length <= C.MAX_DESCRIPTION + 1);

const range = { from: new Date('2026-11-09T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z') };
// ---------- Google : Meet, numéro d'appel, code, description ; lien Zoom dans la description à défaut
const gEvents = [
  { id: 'g1', summary: 'Point client', start: { dateTime: '2026-11-11T10:00:00Z' }, end: { dateTime: '2026-11-11T10:30:00Z' }, description: '<b>Ordre du jour</b><br>Budget', conferenceData: { conferenceId: 'abc-defg-hij', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }, { entryPointType: 'phone', uri: 'tel:+1-650-555-0100', label: '+1 650-555-0100', pin: '555 000' }] } },
  { id: 'g2', summary: 'Démo', start: { dateTime: '2026-11-12T10:00:00Z' }, end: { dateTime: '2026-11-12T11:00:00Z' }, description: 'Lien : https://us02web.zoom.us/j/12345678901?pwd=zz' },
  { id: 'g3', summary: 'Perso', visibility: 'private', start: { dateTime: '2026-11-13T10:00:00Z' }, end: { dateTime: '2026-11-13T11:00:00Z' }, description: 'secret https://meet.google.com/abc-defg-hij', hangoutLink: 'https://meet.google.com/abc-defg-hij' },
];
const asked = [];
const gHttp = async (req) => { asked.push(req.url); return { status: 200, json: { items: gEvents } }; };
const g = await google.listEvents({ http: gHttp, accessToken: 't', ...range });
assert.equal(g[0].joinUrl, 'https://meet.google.com/abc-defg-hij');
assert.deepEqual(g[0].dialIn, [{ label: '+1 650-555-0100', uri: 'tel:+16505550100', pin: '555000' }]);
assert.equal(g[0].conferenceCode, 'abc-defg-hij');
assert.equal(g[0].description, 'Ordre du jour\nBudget');
assert.equal(g[1].joinUrl, 'https://us02web.zoom.us/j/12345678901?pwd=zz', 'lien Zoom trouvé dans la description');
assert.deepEqual(g[1].dialIn, []);

// ---------- Microsoft : Teams, numéro de conférence, aperçu
const mEvents = [
  { id: 'm1', subject: 'Comité', start: { dateTime: '2026-11-11T09:00:00' }, end: { dateTime: '2026-11-11T10:00:00' }, location: { displayName: 'Salle 3' }, bodyPreview: 'Ordre du jour', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=1', tollNumber: '+33 1 23 45 67 89', conferenceId: '123 456 789' } },
  { id: 'm2', subject: 'Sans visio', start: { dateTime: '2026-11-12T09:00:00' }, end: { dateTime: '2026-11-12T10:00:00' }, location: { displayName: 'Bureau' }, bodyPreview: '' },
];
let mUrl = '';
const m = await microsoft.listEvents({ http: async (req) => { mUrl = req.url; return { status: 200, json: { value: mEvents } }; }, accessToken: 't', ...range });
assert.match(mUrl, /onlineMeeting/, 'le champ onlineMeeting est demandé à Graph');
assert.equal(m[0].joinUrl, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=1');
assert.deepEqual(m[0].dialIn, [{ label: '+33 1 23 45 67 89', uri: 'tel:+33123456789', pin: '123456789' }]);
assert.equal(m[1].joinUrl, '');
assert.deepEqual(m[1].dialIn, []);

// ---------- vue publique : un événement privé n'expose rien
const open = publicEvent(g[0]);
assert.equal(open.joinUrl, 'https://meet.google.com/abc-defg-hij');
assert.equal(open.dialIn.length, 1);
const hidden = publicEvent(g[2]);
assert.equal(hidden.title, 'Occupé');
assert.equal(hidden.joinUrl, '');
assert.deepEqual(hidden.dialIn, []);
assert.equal(hidden.description, '');
assert.equal(hidden.conferenceCode, '');
assert.equal(hidden.location, '');

console.log('eventConnection: ok');
