// Run: node src/tests/minutesRoutes.test.js
import assert from 'node:assert/strict';
import { minutesCompanyRoutes } from '../routes/minutesCompany.js';
import { escrowRoutes } from '../routes/escrow.js';

// aucune route ne crédite de minutes sans paiement
const paths = (router) => router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
assert(!paths(minutesCompanyRoutes).includes('post /buy-minutes'), 'minutes-company/buy-minutes retiré');
assert(!paths(escrowRoutes).includes('post /buy-minutes'), 'escrow/buy-minutes retiré');
assert(paths(minutesCompanyRoutes).includes('post /charge-call'), 'charge-call (service à service) conservé');

console.log('minutesRoutes.test.js OK');
