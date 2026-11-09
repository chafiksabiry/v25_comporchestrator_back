import assert from 'node:assert/strict';

process.env.TELNYX_API_KEY ||= 'x';
process.env.TWILIO_ACCOUNT_SID ||= 'ACx';
process.env.TWILIO_AUTH_TOKEN ||= 'x';
process.env.TWILIO_INVENTORY_EXCLUDE = '+33218940999, +13023132631';

const { phoneNumberService, INVENTORY_FRIENDLY_PREFIX } = await import('../services/phoneNumberService.js');
const { PhoneNumber } = await import('../models/PhoneNumber.js');
PhoneNumber.prototype.save = async function save() { return this; };

const num = (phoneNumber, friendlyName, voice = true) => ({ sid: 'PN' + phoneNumber.slice(-6), phoneNumber, friendlyName, capabilities: { voice, sms: false, mms: false } });
const OWNED = [
  num('+33218940260', 'Gig Number:+33218940260'),        // issu de la plateforme, libre → proposé
  num('+33218940920', 'Gig Number:+33218940920'),        // issu de la plateforme, déjà détenu par une entreprise → pas proposé
  num('+33218940999', 'Gig Number:+33218940999'),        // exclu par la configuration → pas proposé
  num('+33162044030', '+33 1 62 04 40 30'),              // acheté à la main, nom quelconque, libre → proposé aussi
  num('+13023132631', 'Gig Number:+13023132631'),        // exclu par la configuration → pas proposé
  num('+442081942726', 'Gig Number:+442081942726'),      // britannique, libre → proposé pour GB
  num('+33162044499', 'Gig Number:+33162044499', false), // sans voix → pas proposé
];
const ASSIGNED = new Set(['+33218940920']);

const created = [];
phoneNumberService.twilioClient = {
  incomingPhoneNumbers: {
    list: async (opts = {}) => (opts.phoneNumber ? OWNED.filter((n) => n.phoneNumber === opts.phoneNumber) : OWNED),
    create: async (o) => { created.push(o); return { sid: 'PNnew', phoneNumber: o.phoneNumber, friendlyName: o.friendlyName, capabilities: {} }; },
  },
};
phoneNumberService.unassignedAmong = async (list) => list.filter((n) => !ASSIGNED.has(n.phoneNumber));

assert.equal(INVENTORY_FRIENDLY_PREFIX, 'Gig Number:');

// Liste : seulement l'inventaire libre du pays demandé, marqué `inventory`
const fr = await phoneNumberService.listClaimableInventory({ countryCode: 'FR' });
assert.deepEqual(fr.map((n) => n.phoneNumber).sort(), ['+33162044030', '+33218940260']);
assert.equal(fr[0].inventory, true);
assert.equal(fr[0].isoCountry, 'FR');
const gb = await phoneNumberService.listClaimableInventory({ countryCode: 'gb' });
assert.deepEqual(gb.map((n) => n.phoneNumber), ['+442081942726']);
assert.deepEqual(await phoneNumberService.listClaimableInventory({ countryCode: 'US' }), []);
assert.equal((await phoneNumberService.listClaimableInventory({ countryCode: 'FR', limit: 0 })).length, 0);

// Éligibilité d'un numéro précis
assert.deepEqual((await phoneNumberService.findClaimableInventoryNumber('+33218940260')).claimable, true);
assert.deepEqual(await phoneNumberService.findClaimableInventoryNumber('+33218940920'), { owned: true, claimable: false, number: OWNED[1] });
assert.equal((await phoneNumberService.findClaimableInventoryNumber('+33162044030')).claimable, true);
assert.equal((await phoneNumberService.findClaimableInventoryNumber('+13023132631')).claimable, false);
assert.deepEqual(await phoneNumberService.findClaimableInventoryNumber('+33199999999'), { owned: false, claimable: false, number: null });

// Achat : un numéro d'inventaire libre est pris sans nouvel achat Twilio
const claimed = await phoneNumberService.purchaseTwilioNumber('+33218940260', null, undefined, '64b000000000000000000001', {});
assert.equal(claimed.phoneNumber, '+33218940260');
assert.equal(created.length, 0, 'aucun achat Twilio pour un numéro déjà possédé');

// Un numéro possédé mais non proposable (propre à HARX, déjà détenu) est refusé et rien n'est acheté
for (const bad of ['+13023132631', '+33218940920']) {
  await assert.rejects(() => phoneNumberService.purchaseTwilioNumber(bad, null, undefined, '64b000000000000000000001', {}), (e) => e.code === 'NUMBER_NOT_AVAILABLE' || /Twilio Purchase Failed/.test(e.message));
}
assert.equal(created.length, 0);

// Un numéro absent de l'inventaire suit l'achat normal
await phoneNumberService.purchaseTwilioNumber('+33199999999', null, undefined, '64b000000000000000000001', {});
assert.equal(created.length, 1);
assert.equal(created[0].phoneNumber, '+33199999999');
console.log('inventoryNumbers.test OK');
process.exit(0);
