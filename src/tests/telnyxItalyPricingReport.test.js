import assert from 'node:assert/strict';

const {
  italyPricingReportEnabled, availableNumbersUrl, requirementsUrl, formatNumberLine, formatRequirementLines, logTelnyxItalyPricing, NUMBER_TYPES, requirementDetailUrl,
} = await import('../services/telnyxItalyPricingReport.js');

// --- Activation : uniquement avec la valeur 1
assert.equal(italyPricingReportEnabled({ LOG_TELNYX_IT_PRICING: '1' }), true);
assert.equal(italyPricingReportEnabled({ LOG_TELNYX_IT_PRICING: ' 1 ' }), true);
assert.equal(italyPricingReportEnabled({ LOG_TELNYX_IT_PRICING: '' }), false);
assert.equal(italyPricingReportEnabled({ LOG_TELNYX_IT_PRICING: 'true' }), false);
assert.equal(italyPricingReportEnabled({}), false);

// --- URL
assert.deepEqual(NUMBER_TYPES, ['local', 'mobile', 'national', 'toll_free']);
const u = new URL(availableNumbersUrl('mobile'));
assert.equal(u.pathname, '/v2/available_phone_numbers');
assert.equal(u.searchParams.get('filter[country_code]'), 'IT');
assert.equal(u.searchParams.get('filter[phone_number_type]'), 'mobile');
assert.equal(u.searchParams.get('filter[limit]'), '5');
const r = new URL(requirementsUrl('local'));
assert.equal(r.pathname, '/v2/requirements');
assert.equal(r.searchParams.get('filter[country_code]'), 'IT');
assert.equal(r.searchParams.get('filter[phone_number_type]'), 'local');
assert.equal(new URL(requirementsUrl(null)).searchParams.get('filter[phone_number_type]'), null);

// --- Ligne par numéro
const num = {
  phone_number: '+390212345678', phone_number_type: 'local', reservable: true, quickship: false, best_effort: false,
  cost_information: { upfront_cost: '1.00', monthly_cost: '1.50', currency: 'USD' },
  features: [{ name: 'voice' }, { name: 'emergency' }],
  region_information: [{ region_type: 'rate_center', region_name: 'MILANO' }, { region_type: 'country_code', region_name: 'IT' }],
};
assert.equal(
  formatNumberLine('local', num),
  '[telnyx-it-pricing] type=local +390212345678 type_telnyx=local initial=1.00 mensuel=1.50 devise=USD features=voice,emergency region=rate_center:MILANO|country_code:IT reservable=true quickship=false best_effort=false',
);
assert.match(formatNumberLine('mobile', {}), /initial=\? mensuel=\? devise=\? features=\(aucune\) region=\?/);

assert.equal(requirementDetailUrl('a b'), 'https://api.telnyx.com/v2/requirements/a%20b');

// --- Exigences
const reqLines = formatRequirementLines('local', {
  id: 'req1', country_code: 'IT', phone_number_type: 'local', action: 'ordering', locality: null,
  requirements_types: [{ name: 'Proof of address', type: 'document', description: 'Local   address\nin Italy', example: 'utility bill', acceptance_criteria: { locality_limit: 'Italy' } }],
});
assert.equal(reqLines[0], '[telnyx-it-pricing] EXIGENCES type=local id=req1 pays=IT type_numero=local action=ordering locality=-');
assert.equal(reqLines[1], '[telnyx-it-pricing]   - Proof of address [document] : Local address in Italy | ex. utility bill | critères {"locality_limit":"Italy"}');

// --- Bout en bout avec un faux client HTTP : uniquement des GET, clé jamais journalisée
const KEY = 'KEY_SECRET_0123456789';
const urls = [];
const http = {
  get: async (url, opts) => {
    assert.equal(opts.headers.Authorization, `Bearer ${KEY}`);
    urls.push(url);
    if (url.includes('available_phone_numbers') && url.includes('toll_free')) {
      const e = new Error('boom'); e.response = { status: 400, data: { errors: [{ code: '10015', title: 'Bad Request', detail: 'no inventory' }] } }; throw e;
    }
    if (url.includes('available_phone_numbers')) return { data: { data: [num], metadata: { total_results: 1 } } };
    return { data: { data: [{ id: 'req1', country_code: 'IT', phone_number_type: 'local', action: 'ordering', requirements_types: [] }] } };
  },
};
const out = [];
await logTelnyxItalyPricing({ apiKey: KEY, http, log: (l) => out.push(l) });
assert.equal(urls.length, 4 + 5 + 1 + 1);
assert.ok(urls.some((x) => x.endsWith('/v2/requirements/req1')));
assert.ok(out.some((l) => l.includes('champs=id,country_code,phone_number_type,action,requirements_types')));
assert.ok(out.every((l) => !l.includes(KEY)));
assert.ok(out.some((l) => l.includes('DISPONIBLES type=toll_free : échec HTTP 400 10015 Bad Request no inventory')));
assert.ok(out.some((l) => l.includes('DISPONIBLES type=mobile : 1 renvoyé(s), total=1')));
assert.ok(out.some((l) => l.includes('EXIGENCES type=tous : 1 enregistrement(s)')));
assert.equal(out.at(-1), '[telnyx-it-pricing] fin');

// --- Sans clé : rien n'est appelé
const out2 = [];
await logTelnyxItalyPricing({ apiKey: '', http: { get: async () => { throw new Error('ne doit pas être appelé'); } }, log: (l) => out2.push(l) });
assert.deepEqual(out2, ['[telnyx-it-pricing] clé Telnyx absente : diagnostic ignoré']);

console.log('telnyxItalyPricingReport tests OK');
