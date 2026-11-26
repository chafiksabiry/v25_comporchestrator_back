import assert from 'node:assert/strict';

const {
  capabilitiesReportEnabled, maskSid, deduceNumberType, formatNumberLine, summarize, formatTotalLine, logTwilioCapabilities,
} = await import('../services/twilioCapabilitiesReport.js');

// --- Activation : uniquement avec la valeur 1
assert.equal(capabilitiesReportEnabled({ LOG_TWILIO_CAPABILITIES: '1' }), true);
assert.equal(capabilitiesReportEnabled({ LOG_TWILIO_CAPABILITIES: ' 1 ' }), true);
assert.equal(capabilitiesReportEnabled({ LOG_TWILIO_CAPABILITIES: '' }), false);
assert.equal(capabilitiesReportEnabled({ LOG_TWILIO_CAPABILITIES: 'true' }), false);
assert.equal(capabilitiesReportEnabled({}), false);

// --- SID masqué : 4 derniers caractères seulement
const SID = 'AC0123456789abcdef0123456789abcd';
assert.equal(maskSid(SID), '…abcd');
assert.equal(maskSid(''), '(inconnu)');
assert.equal(maskSid('AC12'), '(inconnu)');

// --- Types déduits
assert.equal(deduceNumberType('+33612345678'), 'mobile');
assert.equal(deduceNumberType('+33712345678'), 'mobile');
assert.equal(deduceNumberType('+33187654321'), 'local');
assert.equal(deduceNumberType('+33512345678'), 'local');
assert.equal(deduceNumberType('+33912345678'), 'national');
assert.equal(deduceNumberType('+33801234567'), 'toll-free');
assert.equal(deduceNumberType('+447700900123'), 'mobile');
assert.equal(deduceNumberType('+442071234567'), 'local');
assert.equal(deduceNumberType('+441614960000'), 'local');
assert.equal(deduceNumberType('+448001234567'), 'toll-free');
assert.equal(deduceNumberType('+14155550100'), 'local');
assert.equal(deduceNumberType('+18885550100'), 'toll-free');
assert.equal(deduceNumberType('+212612345678'), 'inconnu');

// --- Ligne par numéro
const frMobile = { sid: 'PN1', phoneNumber: '+33612345678', capabilities: { voice: true, sms: true, mms: false }, status: 'in-use', smsUrl: '', bundleSid: 'BU1' };
const line = formatNumberLine(frMobile, { twilioType: 'mobile', holder: { companyId: 'c1', name: 'Cabinet A' } });
assert.equal(line, '[twilio-capabilities] +33612345678 pays=FR type=mobile (twilio) voix=oui sms=oui mms=non attribué=oui société=c1 « Cabinet A » statut=in-use smsUrl=vide bundle=oui');
const ukLine = formatNumberLine({ phoneNumber: '+442071234567', capabilities: { voice: true, sms: false } });
assert.match(ukLine, /pays=GB type=local \(déduit\) voix=oui sms=non mms=\? attribué=non /);
assert.match(formatNumberLine(frMobile, { record: { status: 'released' } }), /attribué=non \(fiche HARX released, non retenue\)/);
assert.ok(!line.includes(SID));

// --- Totaux par pays et type
const totals = summarize([
  { country: 'FR', type: 'local', caps: { voice: true, sms: false }, assigned: true },
  { country: 'FR', type: 'local', caps: { voice: true, sms: true }, assigned: false },
  { country: 'FR', type: 'mobile', caps: { voice: true, sms: true, mms: true }, assigned: true },
  { country: 'GB', type: 'local', caps: { voice: false, sms: false }, assigned: false },
]);
assert.deepEqual(totals.map((t) => `${t.country}/${t.type}`), ['FR/local', 'FR/mobile', 'GB/local']);
assert.equal(formatTotalLine(totals[0]), '[twilio-capabilities] TOTAL FR/local : 2 numéro(s), sms=1, voix=2, mms=0, attribués=1');
assert.equal(formatTotalLine(totals[2]), '[twilio-capabilities] TOTAL GB/local : 1 numéro(s), sms=0, voix=0, mms=0, attribués=0');

// --- Bout en bout avec un faux client : lecture seule, SID jamais complet
const calls = [];
const listOf = (name, rows) => ({ list: async (opts) => { calls.push([name, opts]); return rows; } });
const incoming = listOf('all', [
  frMobile,
  { sid: 'PN2', phoneNumber: '+33187654321', capabilities: { voice: true, sms: false, mms: false }, status: 'in-use' },
]);
incoming.local = listOf('local', [{ sid: 'PN2' }]);
incoming.mobile = listOf('mobile', [{ sid: 'PN1' }]);
incoming.tollFree = { list: async () => { throw new Error('boom'); } };
const fakeClient = { incomingPhoneNumbers: incoming };
const FakePhoneNumber = {
  find: () => ({ select: () => ({ lean: async () => [{ phoneNumber: '+33612345678', companyId: '64b000000000000000000001', status: 'active' }] }) }),
};
const lines = [];
const origWarn = console.warn;
console.warn = () => {};
await logTwilioCapabilities({
  twilioClient: fakeClient, PhoneNumber: FakePhoneNumber, accountSid: SID, log: (l) => lines.push(l),
  held: async (docs) => new Set(docs.map((d) => d.phoneNumber)),
});
console.warn = origWarn;
assert.deepEqual(calls[0], ['all', { limit: 1000 }]);
assert.ok(lines.every((l) => !l.includes(SID)), 'SID complet jamais journalisé');
assert.match(lines[0], /SID …abcd/);
assert.ok(lines.some((l) => l.startsWith('[twilio-capabilities] +33187654321 pays=FR type=local (twilio) voix=oui sms=non') && l.includes('attribué=non ')));
assert.ok(lines.some((l) => l.startsWith('[twilio-capabilities] +33612345678 pays=FR type=mobile (twilio)') && l.includes('attribué=oui société=64b000000000000000000001')));
assert.ok(lines.includes('[twilio-capabilities] TOTAL FR/local : 1 numéro(s), sms=0, voix=1, mms=0, attribués=0'));
assert.ok(lines.includes('[twilio-capabilities] TOTAL FR/mobile : 1 numéro(s), sms=1, voix=1, mms=0, attribués=1'));

// --- Un échec Twilio est journalisé, jamais levé
const origErr = console.error;
let logged = '';
console.error = (...a) => { logged = a.join(' '); };
await logTwilioCapabilities({ twilioClient: { incomingPhoneNumbers: { list: async () => { throw new Error('401'); } } }, PhoneNumber: FakePhoneNumber, accountSid: SID, log: () => {} });
console.error = origErr;
assert.match(logged, /échec/);

console.log('twilioCapabilitiesReport.test.js OK');
