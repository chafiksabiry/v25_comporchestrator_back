// Run: JWT_SECRET=t TELNYX_API_KEY=x TWILIO_ACCOUNT_SID=ACtest TWILIO_AUTH_TOKEN=x node --test src/tests/regulatoryIsolation.test.js
// /api/documents, /api/addresses, /api/requirement-groups (pièces réglementaires des lignes) : avant, AUCUNE authentification et aucun rattachement à une société :
// toute personne connaissant un identifiant lisait, téléchargeait ou supprimait la pièce d'une autre société, lisait ou modifiait son groupe d'exigences.
// Maintenant : JWT obligatoire ; création = personne rattachée à une société (la pièce est enregistrée au nom de cette société) ; lecture, téléchargement,
// suppression, groupe par identifiant = uniquement la société propriétaire (autre société : 404, rien lu chez l'opérateur ni modifié) ; routes par :companyId :
// propriétaire ou membre de CETTE société ; agent / sans société : 403 ; inscription indisponible : 503. Chaîne de middlewares réelle ; opérateur et base simulés.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.TELNYX_API_KEY = process.env.TELNYX_API_KEY || 'x';
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'ACtest';
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || 'x';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const { TelnyxRequirementGroup } = await import('../models/TelnyxRequirementGroup.js');
const { default: RegulatoryAsset } = await import('../models/RegulatoryAsset.js');
const { documentService } = await import('../services/documentService.js');
const { addressService } = await import('../services/addressService.js');
const { telnyxRequirementGroupService: groupService } = await import('../services/telnyxRequirementGroupService.js');
const { documentRoutes } = await import('../routes/document.js');
const { addressRoutes } = await import('../routes/address.js');
const { telnyxRequirementGroupRoutes: groupRoutes } = await import('../routes/telnyxRequirementGroup.js');
const { clearCompanyCache } = await import('../middleware/companyScope.js');

const C1 = '64b0000000000000000000c1'; const C2 = '64b0000000000000000000c2';
const DOC = 'doc-1'; const ADDR = 'addr-1'; const GRP = 'grp-1';
let who; let registrationDown; let external; let local; let claims; let n = 0;
const saved = { log: console.log, warn: console.warn, error: console.error };
beforeEach(() => {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  clearCompanyCache(); external = 0; local = 0; claims = []; registrationDown = false; who = { companyId: C1, isOwner: true };
  const ext = (v) => async () => { external += 1; return v; };
  documentService.uploadDocument = ext({ id: 'new-doc', filename: 'a.pdf' }); documentService.getDocument = ext({ id: DOC }); documentService.deleteDocument = ext({ success: true });
  documentService.downloadDocument = ext({ buffer: Buffer.from('x'), filename: 'a.pdf', mimeType: 'application/pdf' });
  addressService.createBusinessAddress = ext({ id: 'new-addr' }); addressService.retrieveAddress = ext({ id: ADDR });
  groupService.createRequirementGroup = ext({ id: GRP }); groupService.getRequirementGroup = ext({ id: GRP, requirements: [], isComplete: () => true }); groupService.updateRequirements = ext({ id: GRP });
  groupService.getCompanyRequirementGroup = ext({ id: GRP }); groupService.getCompanyRequirementGroups = ext([]);
  // Propriété : DOC / ADDR / GRP appartiennent à C1.
  const owned = [{ kind: 'document', externalId: DOC, companyId: C1 }, { kind: 'address', externalId: ADDR, companyId: C1 }];
  RegulatoryAsset.findOne = (q) => { local += 1; const r = owned.find((x) => x.kind === q.kind && x.externalId === q.externalId && x.companyId === q.companyId); return { select: () => ({ lean: async () => r || null }) }; };
  RegulatoryAsset.updateOne = async (q, u) => { local += 1; claims.push({ q, u }); return {}; };
  TelnyxRequirementGroup.findOne = (q) => { local += 1; const ok = q.telnyxId === GRP && q.companyId === C1; return { select: () => ({ lean: async () => (ok ? { _id: 'g' } : null) }) }; };
  global.fetch = async () => { if (registrationDown) throw new Error('down'); return { ok: true, json: async () => ({ success: true, data: who }) }; };
});
after(() => { Object.assign(console, saved); });

async function call(router, method, path, { params = {}, body = {}, token = true, file = true } = {}) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `${method} ${path}`);
  n += 1; let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code || 200, body: b }; return this; }, send(b) { out = { code: this.code || 200, body: b }; return this; }, setHeader() {}, set() { return this; }, end() { out = out || { code: this.code || 200 }; } };
  const req = { params, body, query: {}, file: file ? { size: 10, buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'a.pdf' } : undefined, headers: token ? { authorization: `Bearer ${jwt.sign({ userId: `u${n}` }, process.env.JWT_SECRET)}` } : {} };
  for (const s of layer.route.stack) {
    if (s.name === 'multerMiddleware') continue; // l'analyse du fichier n'est pas l'objet du test (req.file fourni)
    let next = false; await s.handle(req, res, () => { next = true; }); if (!next) break;
  }
  return out;
}
const ADDR_BODY = { businessName: 'B', streetAddress: 's', locality: 'l', postalCode: '1', countryCode: 'FR', customerReference: 'r' };
const CASES = [
  // [libellé, routeur, méthode, chemin, requête, par identifiant ?]
  ['POST /documents', documentRoutes, 'post', '/', {}, false],
  ['GET /documents/:id', documentRoutes, 'get', '/:documentId', { params: { documentId: DOC } }, true],
  ['GET /documents/:id/download', documentRoutes, 'get', '/:documentId/download', { params: { documentId: DOC } }, true],
  ['DELETE /documents/:id', documentRoutes, 'delete', '/:documentId', { params: { documentId: DOC } }, true],
  ['POST /addresses', addressRoutes, 'post', '/', { body: ADDR_BODY }, false],
  ['GET /addresses/:id', addressRoutes, 'get', '/:addressId', { params: { addressId: ADDR } }, true],
  ['POST /requirement-groups', groupRoutes, 'post', '/', { body: { companyId: C1, destinationZone: 'FR' } }, 'company'],
  ['GET /requirement-groups/:id', groupRoutes, 'get', '/:groupId', { params: { groupId: GRP } }, true],
  ['PATCH /requirement-groups/:id/requirements', groupRoutes, 'patch', '/:groupId/requirements', { params: { groupId: GRP }, body: { requirements: [{ requirementId: 'r', value: 'v' }] } }, true],
  ['GET /requirement-groups/:id/status', groupRoutes, 'get', '/:groupId/status', { params: { groupId: GRP } }, true],
  ['GET /requirement-groups/companies/:c/zones/:z', groupRoutes, 'get', '/companies/:companyId/zones/:destinationZone', { params: { companyId: C1, destinationZone: 'FR' } }, 'company'],
  ['GET /requirement-groups/company/:c/status', groupRoutes, 'get', '/company/:companyId/status', { params: { companyId: C1 } }, 'company'],
];

for (const [label, router, method, path, req, kind] of CASES) {
  test(`${label} : sans jeton 401 ; agent / sans société 403 ; inscription indisponible 503 : aucun appel opérateur ni base`, async () => {
    assert.equal((await call(router, method, path, { ...req, token: false })).code, 401); assert.equal(external + local, 0);
    for (const identity of [{ companyId: C1, isAgent: true }, { companyId: null, isOwner: true }]) {
      who = identity; clearCompanyCache();
      const r = await call(router, method, path, req);
      assert.equal(r.code, 403, JSON.stringify(identity)); assert.equal(external + local, 0);
    }
    registrationDown = true; clearCompanyCache();
    assert.equal((await call(router, method, path, req)).code, 503); assert.equal(external + local, 0);
  });

  test(`${label} : la société d'une AUTRE société ${kind === 'company' ? 'est refusée (403)' : kind ? 'est introuvable (404)' : 'enregistre la pièce à SON nom'}, aucun appel opérateur`, async () => {
    who = { companyId: C2, isOwner: true }; clearCompanyCache();
    const r = await call(router, method, path, req);
    if (kind === 'company') { assert.equal(r.code, 403); assert.equal(external + local, 0); }
    else if (kind) { assert.equal(r.code, 404); assert.equal(external, 0, 'rien lu chez l\'opérateur'); assert.equal(claims.length, 0); }
    else { assert.equal(r.code, 201); assert.equal(claims[0].u.$setOnInsert.companyId, C2, 'pièce enregistrée au nom de la société de l\'appelant'); }
  });

  test(`${label} : le propriétaire et un membre de la société propriétaire y accèdent (chemin légitime)`, async () => {
    for (const isOwner of [true, false]) {
      who = { companyId: C1, isOwner }; clearCompanyCache(); external = 0; claims = [];
      const r = await call(router, method, path, req);
      assert.ok([200, 201].includes(r.code), `${label} owner=${isOwner} -> ${r.code}`); assert.ok(external >= 1);
      if (!kind) assert.equal(claims[0].u.$setOnInsert.companyId, C1);
    }
  });
}
