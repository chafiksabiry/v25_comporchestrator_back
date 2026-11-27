/**
 * Accès aux données de la vérification d'identité. Deux implémentations au même contrat :
 *  - Mongo (production) : modèles IdentityVerification et IdentityDocumentFile ;
 *  - mémoire (tests) : aucune base nécessaire.
 * Toute lecture d'un fichier passe par la société (`companyId`) : impossible d'atteindre le fichier d'un autre compte.
 */
import crypto from 'node:crypto';

const clone = (x) => (x == null ? x : structuredClone(x));

/**
 * Magasin en mémoire (tests seulement). `now` : horloge de l'expiration des images ; par défaut l'heure réelle. Les tests qui fixent
 * l'horloge du service doivent passer la même ici : sinon une image dont l'échéance est calculée sur l'horloge du test (ex. 23/11 10:00)
 * est jugée expirée dès que l'heure réelle la dépasse, et le test échoue selon le jour où il tourne.
 */
export function createMemoryStore({ now = () => new Date() } = {}) {
  const verifications = new Map();
  const files = new Map();
  const id = () => crypto.randomBytes(12).toString('hex');
  let seq = 0;
  return {
    kind: 'memory',
    _verifications: verifications,
    _files: files,
    async createVerification(doc) {
      const v = { _id: id(), status: 'draft', checks: [], ai: [], accessLog: [], fingerprints: { document: null, files: [] }, verifiedCountries: { nationality: null, residence: null }, pendingCountries: [], createdAt: now(), updatedAt: now(), ...clone(doc), _seq: ++seq };
      verifications.set(v._id, v);
      return clone(v);
    },
    async getVerification(vid) { return clone(verifications.get(String(vid)) || null); },
    async updateVerification(vid, patch, { push } = {}) {
      const v = verifications.get(String(vid));
      if (!v) return null;
      Object.assign(v, clone(patch), { updatedAt: now() });
      if (push) for (const [k, val] of Object.entries(push)) v[k] = [...(v[k] || []), ...clone(Array.isArray(val) ? val : [val])];
      return clone(v);
    },
    /** Vérifications d'une société, la plus récente d'abord. */
    async listForCompany(companyId) {
      return [...verifications.values()].filter((v) => v.companyId === String(companyId)).sort((a, b) => b._seq - a._seq).map(clone);
    },
    async listByStatus(status) {
      const match = status === 'pending' ? (v) => v.status === 'approved' && (v.pendingCountries || []).length > 0 : (v) => v.status === status;
      return [...verifications.values()].filter(match).sort((a, b) => a._seq - b._seq).map(clone);
    },
    async supersedeOthers(companyId, keepId, statuses) {
      for (const v of verifications.values()) if (v.companyId === String(companyId) && v._id !== String(keepId) && statuses.includes(v.status)) v.status = 'superseded';
    },
    async findOtherCompanyFingerprint({ document, files: fps }, companyId) {
      for (const v of verifications.values()) {
        if (v.companyId === String(companyId)) continue;
        const who = { companyId: v.companyId, userId: v.userId || null, fullName: v.declared?.fullName || '' };
        if (document && v.fingerprints?.document === document) return { kind: 'document', ...who };
        if (fps?.length && (v.fingerprints?.files || []).some((f) => fps.includes(f))) return { kind: 'file', ...who };
      }
      return null;
    },
    async listStaleProcessing(before) {
      return [...verifications.values()].filter((v) => v.status === 'processing' && v.processingStartedAt && v.processingStartedAt < before).map(clone);
    },
    async createFile(doc) {
      const f = { _id: id(), createdAt: now(), ...doc };
      files.set(f._id, f);
      return { ...f };
    },
    async getFile(companyId, fileId) {
      const f = files.get(String(fileId));
      return f && f.companyId === String(companyId) && (!f.expiresAt || f.expiresAt > now()) ? { ...f } : null;
    },
    async listFiles(verificationId) {
      return [...files.values()].filter((f) => f.verificationId === String(verificationId) && (!f.expiresAt || f.expiresAt > now())).map((f) => ({ ...f }));
    },
    async deleteFile(companyId, fileId) {
      const f = files.get(String(fileId));
      if (f && f.companyId === String(companyId)) files.delete(String(fileId));
    },
    async deleteFilesOf(verificationId) {
      for (const [k, f] of files) if (f.verificationId === String(verificationId)) files.delete(k);
    },
    async setFilesExpiry(verificationId, expiresAt) {
      for (const f of files.values()) if (f.verificationId === String(verificationId)) f.expiresAt = expiresAt;
    },
    async moveFiles(fromId, toId) {
      for (const f of files.values()) if (f.verificationId === String(fromId)) f.verificationId = String(toId);
    },
  };
}

export async function createMongoStore() {
  const [{ IdentityVerification: V }, { IdentityDocumentFile: F }] = await Promise.all([
    import('../../models/IdentityVerification.js'),
    import('../../models/IdentityDocumentFile.js'),
  ]);
  const plain = (d) => (d ? { ...d, _id: String(d._id) } : null);
  const live = () => ({ $or: [{ expiresAt: { $gt: new Date() } }] });
  return {
    kind: 'mongo',
    async createVerification(doc) { return plain((await V.create(doc)).toObject()); },
    async getVerification(vid) { return plain(await V.findById(vid).lean()); },
    async updateVerification(vid, patch, { push } = {}) {
      const update = { $set: patch };
      if (push) update.$push = Object.fromEntries(Object.entries(push).map(([k, val]) => [k, Array.isArray(val) ? { $each: val } : val]));
      return plain(await V.findByIdAndUpdate(vid, update, { new: true }).lean());
    },
    async listForCompany(companyId) { return (await V.find({ companyId: String(companyId) }).sort({ createdAt: -1 }).limit(50).lean()).map(plain); },
    async listByStatus(status) {
      const q = status === 'pending' ? { status: 'approved', 'pendingCountries.0': { $exists: true } } : { status };
      return (await V.find(q).sort({ createdAt: 1 }).limit(200).lean()).map(plain);
    },
    async supersedeOthers(companyId, keepId, statuses) {
      await V.updateMany({ companyId: String(companyId), _id: { $ne: keepId }, status: { $in: statuses } }, { $set: { status: 'superseded' } });
    },
    async findOtherCompanyFingerprint({ document, files: fps }, companyId) {
      const or = [];
      if (document) or.push({ 'fingerprints.document': document });
      if (fps?.length) or.push({ 'fingerprints.files': { $in: fps } });
      if (!or.length) return null;
      const hit = await V.findOne({ companyId: { $ne: String(companyId) }, $or: or }).select('fingerprints companyId userId declared.fullName').lean();
      if (!hit) return null;
      return { kind: document && hit.fingerprints?.document === document ? 'document' : 'file', companyId: hit.companyId, userId: hit.userId || null, fullName: hit.declared?.fullName || '' };
    },
    async listStaleProcessing(before) { return (await V.find({ status: 'processing', processingStartedAt: { $lt: before } }).limit(100).lean()).map(plain); },
    async createFile(doc) { return plain((await F.create(doc)).toObject()); },
    async getFile(companyId, fileId) {
      if (!/^[0-9a-f]{24}$/i.test(String(fileId))) return null;
      return plain(await F.findOne({ _id: fileId, companyId: String(companyId), ...live() }).lean());
    },
    async listFiles(verificationId) { return (await F.find({ verificationId: String(verificationId), ...live() }).lean()).map(plain); },
    async deleteFile(companyId, fileId) {
      if (!/^[0-9a-f]{24}$/i.test(String(fileId))) return;
      await F.deleteOne({ _id: fileId, companyId: String(companyId) });
    },
    async deleteFilesOf(verificationId) { await F.deleteMany({ verificationId: String(verificationId) }); },
    async setFilesExpiry(verificationId, expiresAt) { await F.updateMany({ verificationId: String(verificationId) }, { $set: { expiresAt } }); },
    async moveFiles(fromId, toId) { await F.updateMany({ verificationId: String(fromId) }, { $set: { verificationId: String(toId) } }); },
  };
}
