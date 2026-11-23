/**
 * Vérification d'identité Nomad Solo : orchestration (spec §3). Brouillon de fichiers -> envoi -> analyse (extraction IA puis
 * décision PAR LE CODE) -> validé / revue humaine / refusé. Les pays vérifiés sont enregistrés ici, côté serveur, et lus par les
 * gardes de paiement et d'achat de numéro.
 * Toutes les dépendances sont injectables (base, horloge, extraction, déclaration, file de traitement) : tests sans réseau ni base.
 */
import crypto from 'node:crypto';
import { getIdentityConfig, loadFilesKey, deriveKeys } from './config.js';
import { decide, OUTCOMES, REJECT_CODES } from './decision.js';
import { extractDocument } from './extract.js';
import { decryptBuffer, encryptBuffer, fingerprint, prepareUpload, splitPages } from './files.js';
import { loadDeclaration as defaultLoadDeclaration } from './declaration.js';
import { normalizeIso2 } from './countries.js';

export class IdentityError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const FILE_KINDS = ['passport', 'id_front', 'id_back', 'address_proof'];
export const DOC_TYPES = ['passport', 'id_card', 'residence_permit'];
const REQUIRED = { passport: ['passport', 'address_proof'], id_card: ['id_front', 'id_back', 'address_proof'], residence_permit: ['id_front', 'id_back', 'address_proof'] };
const ID_KINDS_FOR = { passport: ['passport'], id_card: ['id_front', 'id_back'], residence_permit: ['id_front', 'id_back'] };
/** Motifs qu'un admin peut choisir en refusant (spec §7.2, plus les cas « humains »). */
export const ADMIN_REJECT_CODES = [...REJECT_CODES, 'NAME_MISMATCH', 'PROOF_HOLDER_OTHER', 'DOCUMENT_SUSPECTED'];

/** Échecs techniques de NOTRE côté (erreur interne, IA indisponible, clé absente, délai) : ils ne comptent jamais comme un essai. */
const TECHNICAL_REASONS = new Set(['PROCESSING_ERROR', 'PROCESSING_INTERRUPTED', 'AI_UNAVAILABLE']);
const TECHNICAL_AI_ERRORS = new Set(['timeout', 'api_error', 'not_configured']);

/**
 * Un dossier compte-t-il dans les limites d'analyses ? Calculé à la lecture, à partir des données déjà enregistrées (décision,
 * motifs, erreurs d'appel, jetons) : un dossier ancien mal marqué est corrigé sans toucher à la base.
 * Compté seulement si l'analyse a réellement été faite par l'IA (marquée `aiCounted`), sans échec technique, avec des jetons.
 */
export function countsAsAttempt(v) {
  if (!v || !v.aiCounted || !v.aiAt) return false;
  if ((v.decision?.reasonCodes || []).some((r) => TECHNICAL_REASONS.has(r))) return false;
  const ai = Array.isArray(v.ai) ? v.ai : [];
  if (ai.some((a) => TECHNICAL_AI_ERRORS.has(a?.error))) return false;
  if (ai.length && ai.reduce((sum, a) => sum + (Number(a?.input) || 0) + (Number(a?.output) || 0), 0) === 0) return false;
  return true;
}

const fileView = (f) => ({ fileId: String(f._id), kind: f.kind, mime: f.mime, size: f.size });
const uniq = (a) => [...new Set(a.filter(Boolean))];

export function createIdentityService({
  store,
  config = getIdentityConfig,
  now = () => new Date(),
  extract = extractDocument,
  claudeClient = null,
  loadDeclaration = defaultLoadDeclaration,
  schedule = (fn) => setImmediate(fn),
  sharp = undefined,
  logger = console,
} = {}) {
  const cfg = () => (typeof config === 'function' ? config() : config);
  const keys = () => deriveKeys(loadFilesKey(cfg()));

  async function snapshot(companyId) {
    const list = await store.listForCompany(companyId);
    return {
      list,
      draft: list.find((v) => v.status === 'draft') || null,
      current: list.find((v) => !['draft', 'superseded'].includes(v.status)) || null,
      approved: list.find((v) => v.status === 'approved') || null,
    };
  }

  function attemptsUsed(list) {
    const t = now().getTime();
    const counted = list.filter(countsAsAttempt);
    return {
      today: counted.filter((v) => t - new Date(v.aiAt).getTime() < 24 * 3600 * 1000).length,
      total: counted.length,
    };
  }

  function allowedOf(v) {
    if (!v || v.status !== 'approved') return [];
    return uniq([normalizeIso2(v.verifiedCountries?.residence), normalizeIso2(v.verifiedCountries?.nationality)]);
  }

  function pendingOf(v) {
    return (Array.isArray(v?.pendingCountries) ? v.pendingCountries : []).filter((k) => k === 'nationality' || k === 'residence');
  }

  /** La déclaration actuelle a-t-elle changé de pays depuis la vérification validée ? (D12 / D14 : revérification) */
  function isStale(v, declared) {
    if (!v || !declared) return false;
    const changed = (a, b) => normalizeIso2(a) !== normalizeIso2(b);
    return changed(v.declared?.residence, declared.residence) || changed(v.declared?.nationality, declared.nationality);
  }

  /** Contrôles affichables à l'abonné : codes seulement (le portail traduit), jamais de texte libre. */
  const publicChecks = (v) => (v?.checks || []).filter((c) => c.result !== 'info' || c.reason === 'NATIONALITY_NOT_PROVEN').map((c) => ({ code: c.code, result: c.result, reason: c.reason || null }));

  async function status(companyId, { declared = null } = {}) {
    const c = cfg();
    const { list, draft, current, approved } = await snapshot(companyId);
    const used = attemptsUsed(list);
    const draftFiles = draft ? await store.listFiles(draft._id) : [];
    const currentFiles = current && current.status === 'rejected' ? await store.listFiles(current._id) : [];
    const shown = current || null;
    return {
      enabled: c.enabled,
      status: shown ? shown.status : draft ? 'draft' : 'none',
      verificationId: shown ? String(shown._id) : null,
      docType: draft?.docType || shown?.docType || null,
      draft: draft ? { docType: draft.docType, files: draftFiles.map(fileView) } : null,
      reasons: shown?.decision?.reasonCodes || [],
      facts: shown?.extracted?.facts || null,
      checks: publicChecks(shown),
      decidedBy: shown?.decision?.by ? (shown.decision.by === 'auto' ? 'auto' : 'team') : null,
      allowedCountries: allowedOf(approved),
      verifiedCountries: approved ? approved.verifiedCountries : null,
      /** Validé pour un pays : l'autre pays déclaré est encore « en cours de vérification » par l'équipe. */
      pendingCountries: approved ? pendingOf(approved) : [],
      stale: approved ? isStale(approved, declared) : false,
      attemptsLeftToday: Math.max(0, c.maxAiAttemptsPerDay - used.today),
      attemptsLeftTotal: Math.max(0, c.maxAiAttemptsTotal - used.total),
      reviewEtaHours: c.reviewEtaHours,
      reviewRequested: Boolean(shown?.reviewRequestedAt),
      canReanalyze: Boolean(shown && shown.status === 'rejected' && currentFiles.length && !draft),
      imagesDeleted: Boolean(shown && ['approved', 'rejected'].includes(shown.status) && !currentFiles.length),
    };
  }

  async function upload(companyId, userId, { kind, docType, buffer }) {
    if (!FILE_KINDS.includes(kind)) throw new IdentityError(400, 'FILE_KIND_INVALID');
    const type = DOC_TYPES.includes(docType) ? docType : kind === 'passport' ? 'passport' : 'id_card';
    if (kind !== 'address_proof' && !ID_KINDS_FOR[type].includes(kind)) throw new IdentityError(400, 'FILE_KIND_INVALID');
    const k = keys();
    const prepared = await prepareUpload(buffer, kind, cfg(), { now: now(), sharp });
    let { draft } = await snapshot(companyId);
    if (!draft) draft = await store.createVerification({ companyId: String(companyId), userId: userId ? String(userId) : null, status: 'draft', docType: type });
    else if (draft.docType !== type) draft = await store.updateVerification(draft._id, { docType: type });
    const existing = await store.listFiles(draft._id);
    for (const f of existing) {
      // Même emplacement remplacé ; pièces d'un autre type de document retirées (passeport <-> recto/verso).
      if (f.kind === kind || (f.kind !== 'address_proof' && !ID_KINDS_FOR[type].includes(f.kind))) await store.deleteFile(companyId, f._id);
    }
    const fileId = crypto.randomBytes(12).toString('hex');
    const enc = encryptBuffer(prepared.data, k.enc, `identity:${companyId}:${fileId}`);
    const f = await store.createFile({
      _id: fileId, verificationId: String(draft._id), companyId: String(companyId), kind, mime: prepared.mime, size: prepared.size,
      sha256: prepared.sha256, ...enc, meta: prepared.meta, signals: prepared.signals, expiresAt: new Date(now().getTime() + cfg().fileTtlMs),
    });
    return { ...fileView(f), previewOk: true };
  }

  async function removeFile(companyId, fileId) {
    const { draft } = await snapshot(companyId);
    const f = await store.getFile(companyId, fileId);
    if (!f || !draft || f.verificationId !== String(draft._id)) throw new IdentityError(404, 'FILE_NOT_FOUND');
    await store.deleteFile(companyId, fileId);
    return { removed: true };
  }

  async function submit(req, companyId, userId) {
    const c = cfg();
    const snap = await snapshot(companyId);
    let target = snap.draft;
    if (!target && snap.current?.status === 'rejected') {
      // Correction de la déclaration après un refus : nouvelle analyse avec les images encore conservées (24 h), sans renvoi.
      const kept = await store.listFiles(snap.current._id);
      if (kept.length) {
        target = await store.createVerification({ companyId: String(companyId), userId: userId ? String(userId) : null, status: 'draft', docType: snap.current.docType });
        await store.moveFiles(snap.current._id, target._id);
        await store.setFilesExpiry(target._id, new Date(now().getTime() + c.fileTtlMs));
      }
    }
    if (!target) throw new IdentityError(409, 'FILES_MISSING', { missing: REQUIRED.id_card });
    const files = await store.listFiles(target._id);
    const missing = REQUIRED[target.docType].filter((k) => !files.some((f) => f.kind === k));
    if (missing.length) throw new IdentityError(409, 'FILES_MISSING', { missing });
    // Déclaration relue côté serveur : rien n'est lu dans le corps de la requête.
    const declared = await loadDeclaration(req, companyId);
    const incomplete = ['fullName', 'residence', 'nationality'].filter((k) => !declared[k]);
    if (incomplete.length) throw new IdentityError(409, 'DECLARATION_INCOMPLETE', { missing: incomplete });
    const used = attemptsUsed(snap.list);
    const attempt = (snap.list.filter((v) => v.status !== 'draft').length || 0) + 1;
    await store.supersedeOthers(companyId, target._id, ['review', 'rejected', 'processing']);
    if (used.today >= c.maxAiAttemptsPerDay || used.total >= c.maxAiAttemptsTotal) {
      // Au-delà des limites : revue humaine obligatoire, aucun appel à l'IA (spec §9.3).
      await store.updateVerification(target._id, {
        status: 'review', declared, attempt, decision: { outcome: 'review', reasonCodes: ['ATTEMPT_LIMIT'], by: 'auto', at: now() },
        checks: [{ code: 'ATTEMPTS', result: 'review', detail: 'Limite d’analyses automatiques atteinte', reason: 'ATTEMPT_LIMIT' }],
      });
      return { status: 'review' };
    }
    await store.updateVerification(target._id, { status: 'processing', declared, attempt, processingStartedAt: now() });
    const id = String(target._id);
    schedule(() => { process(id).catch((e) => logger.error?.('[identity] traitement :', e?.message)); });
    return { status: 'processing', verificationId: id };
  }

  async function process(verificationId) {
    const v = await store.getVerification(verificationId);
    if (!v || v.status !== 'processing') return null;
    try {
      return await analyse(v);
    } catch (e) {
      // Jamais de validation par défaut : une erreur interne part en revue humaine.
      logger.error?.('[identity] analyse en échec :', e?.code || e?.message);
      await store.updateVerification(v._id, {
        status: 'review', decision: { outcome: 'review', reasonCodes: ['PROCESSING_ERROR'], by: 'auto', at: now() },
        checks: [{ code: 'PROCESSING', result: 'review', detail: 'Erreur interne pendant l’analyse', reason: 'PROCESSING_ERROR' }],
      });
      return { outcome: 'review', reasonCodes: ['PROCESSING_ERROR'] };
    }
  }

  async function analyse(v) {
    const c = cfg();
    const k = keys();
    const files = await store.listFiles(v._id);
    // Un PDF rendu en plusieurs pages est envoyé à l'IA en autant d'images (une par page).
    const clear = (f) => splitPages({ mime: f.mime, meta: f.meta, data: decryptBuffer(f, k.enc, `identity:${v.companyId}:${f._id}`) });
    const order = ['passport', 'id_front', 'id_back'];
    const idFiles = files.filter((f) => order.includes(f.kind)).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const proofFile = files.find((f) => f.kind === 'address_proof');
    const deps = { cfg: c, claude: claudeClient };
    const [idRes, proofRes] = await Promise.all([
      idFiles.length ? extract('identity', idFiles.flatMap(clear), deps) : { ok: false, error: 'invalid_output', model: c.model },
      proofFile ? extract('proof', clear(proofFile), deps) : { ok: false, error: 'invalid_output', model: c.model },
    ]);
    const aiCalled = [idRes, proofRes].some((r) => r.ok || !['not_configured'].includes(r.error));

    // Signaux techniques des fichiers (EXIF, PDF), plus cohérence date de création PDF / date imprimée.
    const signals = [];
    for (const f of files) for (const s of f.signals || []) signals.push({ code: s.code, detail: `${f.kind} : ${s.detail}` });
    const proofIssue = proofRes.ok ? proofRes.data.issue_date : null;
    const pdfCreated = proofFile?.meta?.pdfCreationDate;
    if (pdfCreated && proofIssue && /^\d{4}-\d{2}-\d{2}$/.test(proofIssue) && Date.parse(pdfCreated) + 24 * 3600 * 1000 < Date.parse(proofIssue)) {
      signals.push({ code: 'PDF_CREATED_BEFORE_ISSUE', detail: 'PDF créé avant la date d’émission imprimée' });
    }
    const input = { declared: v.declared, id: idRes.ok ? idRes.data : null, idError: idRes.ok ? null : idRes.error, proof: proofRes.ok ? proofRes.data : null, proofError: proofRes.ok ? null : proofRes.error, now: now(), rules: { minAge: c.minAge, proofMaxMonths: c.proofMaxMonths } };
    let result = decide({ ...input, signals });

    // Empreintes (anti-réutilisation entre comptes) : le numéro de document n'est jamais stocké, seulement son HMAC.
    const fps = {
      document: result.documentNumber?.number ? fingerprint(k.hmac, 'doc', result.documentNumber.country, result.documentNumber.type, result.documentNumber.number) : null,
      files: files.map((f) => fingerprint(k.hmac, 'file', f.sha256)),
    };
    const reuse = await store.findOtherCompanyFingerprint(fps, v.companyId);
    if (reuse) {
      signals.push(reuse.kind === 'document'
        ? { code: 'DOCUMENT_REUSED', detail: 'Même pièce d’identité déjà présentée sur un autre compte' }
        : { code: 'FILE_REUSED', detail: 'Même fichier déjà envoyé par un autre compte' });
      result = decide({ ...input, signals });
    }
    result.documentNumber = null;

    // Premier refus « illisible » : la tentative n'est pas décomptée (spec §5.5).
    const list = await store.listForCompany(v.companyId);
    const freeUsed = list.some((x) => String(x._id) !== String(v._id) && x.aiAt && !x.aiCounted && (x.decision?.reasonCodes || []).includes('UNREADABLE'));
    const onlyUnreadable = result.outcome === OUTCOMES.REJECTED && result.reasonCodes.length === 1 && result.reasonCodes[0] === 'UNREADABLE';
    const counted = aiCalled && !(onlyUnreadable && !freeUsed);

    const ai = [['identity', idRes], ['proof', proofRes]].map(([doc, r]) => ({
      doc, model: r.model || c.model, requestId: r.requestId || null, input: r.usage?.input || 0, output: r.usage?.output || 0, cacheRead: r.usage?.cacheRead || 0, error: r.ok ? null : r.error, at: now(),
    }));
    const updated = await store.updateVerification(v._id, {
      status: result.outcome,
      checks: result.checks,
      decision: { outcome: result.outcome, reasonCodes: result.reasonCodes, by: 'auto', at: now() },
      verifiedCountries: result.verifiedCountries || { nationality: null, residence: null },
      pendingCountries: result.outcome === OUTCOMES.APPROVED ? (result.pendingCountries || []) : [],
      fingerprints: fps,
      extracted: minimize(idRes.ok ? idRes.data : null, proofRes.ok ? proofRes.data : null, result.facts),
      aiCounted: counted,
      aiAt: aiCalled ? now() : null,
    }, { push: { ai } });
    await afterDecision(updated, result.outcome);
    logger.log?.(`[identity] décision ${result.outcome} (${result.reasonCodes.join(',') || '-'}) jetons ${ai.reduce((s, a) => s + a.input + a.output, 0)}`);
    return { outcome: result.outcome, reasonCodes: result.reasonCodes };
  }

  /** Images : supprimées dès la décision (validé : tout de suite ; refusé : 24 h pour une correction ; revue : à la décision humaine). */
  async function afterDecision(v, outcome) {
    const c = cfg();
    if (outcome === OUTCOMES.APPROVED) {
      // Validé pour un pays, l'autre en revue : les images restent pour l'équipe (jamais au-delà de 30 jours après l'envoi).
      if (pendingOf(v).length) await store.setFilesExpiry(v._id, new Date(new Date(v.createdAt || now()).getTime() + c.fileTtlMs));
      else await store.deleteFilesOf(v._id);
      await store.supersedeOthers(v.companyId, v._id, ['approved', 'review', 'rejected']);
    } else if (outcome === OUTCOMES.REJECTED) {
      await store.setFilesExpiry(v._id, new Date(now().getTime() + c.keepAfterRejectMs));
    }
  }

  async function requestReview(companyId) {
    const { current } = await snapshot(companyId);
    if (!current || current.status !== 'rejected') throw new IdentityError(409, 'NOTHING_TO_REVIEW');
    const c = cfg();
    await store.updateVerification(current._id, {
      status: 'review', reviewRequestedAt: now(),
      decision: { ...(current.decision || {}), outcome: 'review', reasonCodes: uniq([...(current.decision?.reasonCodes || []), 'HUMAN_REVIEW_REQUESTED']), at: now() },
    });
    // Les images encore présentes restent disponibles pour la revue (jamais au-delà de 30 jours après l'envoi).
    await store.setFilesExpiry(current._id, new Date(new Date(current.createdAt || now()).getTime() + c.fileTtlMs));
    return { status: 'review' };
  }

  async function recoverStale() {
    const before = new Date(now().getTime() - cfg().staleProcessingMs);
    for (const v of await store.listStaleProcessing(before)) {
      await store.updateVerification(v._id, {
        status: 'review', decision: { outcome: 'review', reasonCodes: ['PROCESSING_INTERRUPTED'], by: 'auto', at: now() },
        checks: [...(v.checks || []), { code: 'PROCESSING', result: 'review', detail: 'Analyse interrompue (redémarrage)', reason: 'PROCESSING_INTERRUPTED' }],
      });
    }
  }

  /**
   * Pays vérifiés d'une société (garde de paiement et d'achat) : uniquement depuis cette collection serveur.
   * @returns {Promise<{verified: boolean, countries: string[], declared: object|null, residence: string|null, nationality: string|null}>}
   */
  async function verifiedCountriesFor(companyId) {
    const { approved } = await snapshot(companyId);
    if (!approved) return { verified: false, countries: [], declared: null, residence: null, nationality: null };
    return {
      verified: true,
      countries: allowedOf(approved),
      declared: approved.declared || null,
      residence: normalizeIso2(approved.verifiedCountries?.residence) || null,
      nationality: normalizeIso2(approved.verifiedCountries?.nationality) || null,
    };
  }

  // ---------------- Administration (revue humaine) ----------------

  async function adminList(statusFilter = 'review') {
    const st = ['review', 'pending', 'processing', 'rejected', 'approved'].includes(statusFilter) ? statusFilter : 'review';
    const t = now().getTime();
    return (await store.listByStatus(st)).map((v) => ({
      id: String(v._id), companyId: v.companyId, name: v.declared?.fullName || '', docType: v.docType, status: v.status,
      createdAt: v.createdAt, ageHours: Math.floor((t - new Date(v.updatedAt || v.createdAt).getTime()) / 3600000),
      reasons: v.decision?.reasonCodes || [], pendingCountries: pendingOf(v), reviewRequested: Boolean(v.reviewRequestedAt),
      overdue: t - new Date(v.updatedAt || v.createdAt).getTime() > 72 * 3600000,
    }));
  }

  async function adminDetail(id) {
    const v = await store.getVerification(id);
    if (!v) throw new IdentityError(404, 'NOT_FOUND');
    const files = await store.listFiles(v._id);
    return {
      id: String(v._id), companyId: v.companyId, status: v.status, docType: v.docType, attempt: v.attempt, createdAt: v.createdAt,
      declared: v.declared || null, extracted: v.extracted || null, checks: v.checks || [], decision: v.decision || null,
      verifiedCountries: v.verifiedCountries || null, pendingCountries: pendingOf(v), reviewRequestedAt: v.reviewRequestedAt || null,
      files: files.map((f) => ({ ...fileView(f), signals: f.signals || [], meta: f.meta || {} })),
      accessLog: v.accessLog || [], ai: (v.ai || []).map((a) => ({ doc: a.doc, model: a.model, error: a.error, tokens: (a.input || 0) + (a.output || 0) })),
    };
  }

  async function adminFile(id, fileId, adminId, page = 0) {
    const v = await store.getVerification(id);
    if (!v) throw new IdentityError(404, 'NOT_FOUND');
    const f = await store.getFile(v.companyId, fileId);
    if (!f || f.verificationId !== String(v._id)) throw new IdentityError(404, 'FILE_NOT_FOUND');
    await store.updateVerification(v._id, {}, { push: { accessLog: { adminId: String(adminId), action: 'view_file', fileId: String(fileId), at: now() } } });
    const pages = splitPages({ mime: f.mime, meta: f.meta, data: decryptBuffer(f, keys().enc, `identity:${v.companyId}:${f._id}`) });
    const n = Number.parseInt(page, 10);
    return pages[Number.isInteger(n) && n >= 0 && n < pages.length ? n : 0];
  }

  async function adminDecide(id, adminId, body = {}) {
    const v = await store.getVerification(id);
    if (!v) throw new IdentityError(404, 'NOT_FOUND');
    const outcome = String(body.outcome || '');
    const note = String(body.note || '').slice(0, 500);
    const by = `admin:${adminId}`;
    if (v.status === 'approved' && pendingOf(v).length) return decidePending(v, adminId, outcome, body, note, by);
    if (v.status !== 'review') throw new IdentityError(409, 'NOT_IN_REVIEW');
    let patch;
    if (outcome === 'approved') {
      // Pays vérifiés choisis par l'admin, bornés à la déclaration (règle produit : résidence OU nationalité).
      const residence = normalizeIso2(body.residence) && normalizeIso2(body.residence) === normalizeIso2(v.declared?.residence) ? normalizeIso2(body.residence) : null;
      const nationality = normalizeIso2(body.nationality) && normalizeIso2(body.nationality) === normalizeIso2(v.declared?.nationality) ? normalizeIso2(body.nationality) : null;
      if (!residence && !nationality) throw new IdentityError(400, 'COUNTRIES_REQUIRED');
      patch = { status: 'approved', verifiedCountries: { residence, nationality }, decision: { outcome: 'approved', reasonCodes: [], by, at: now(), note } };
    } else if (outcome === 'rejected') {
      const code = String(body.reasonCode || '');
      if (!ADMIN_REJECT_CODES.includes(code)) throw new IdentityError(400, 'REASON_REQUIRED');
      patch = { status: 'rejected', decision: { outcome: 'rejected', reasonCodes: [code], by, at: now(), note } };
    } else if (outcome === 'resubmit') {
      patch = { status: 'rejected', decision: { outcome: 'rejected', reasonCodes: ['RESUBMIT_REQUESTED'], by, at: now(), note } };
    } else throw new IdentityError(400, 'OUTCOME_INVALID');
    const updated = await store.updateVerification(v._id, patch, { push: { accessLog: { adminId: String(adminId), action: `decision:${outcome}`, fileId: null, at: now() } } });
    // Décision humaine : images supprimées tout de suite, quelle que soit l'issue.
    await store.deleteFilesOf(v._id);
    if (outcome === 'approved') await store.supersedeOthers(v.companyId, v._id, ['approved', 'review', 'rejected']);
    return { status: updated.status, verifiedCountries: updated.verifiedCountries };
  }

  /**
   * Dossier validé pour un pays, l'autre « en revue » : l'équipe ajoute le pays en attente (« approved ») ou le laisse fermé
   * (« rejected » / « resubmit »). Le pays déjà validé n'est JAMAIS retiré par cette décision.
   */
  async function decidePending(v, adminId, outcome, body, note, by) {
    const pending = pendingOf(v);
    const current = { residence: normalizeIso2(v.verifiedCountries?.residence) || null, nationality: normalizeIso2(v.verifiedCountries?.nationality) || null };
    let verifiedCountries = current;
    let code = null;
    if (outcome === 'approved') {
      const add = {};
      for (const k of pending) {
        const asked = normalizeIso2(body[k]);
        if (asked && asked === normalizeIso2(v.declared?.[k])) add[k] = asked;
      }
      if (!Object.keys(add).length) throw new IdentityError(400, 'COUNTRIES_REQUIRED');
      verifiedCountries = { ...current, ...add };
    } else if (outcome === 'rejected') {
      code = String(body.reasonCode || '');
      if (!ADMIN_REJECT_CODES.includes(code)) throw new IdentityError(400, 'REASON_REQUIRED');
    } else if (outcome === 'resubmit') code = 'RESUBMIT_REQUESTED';
    else throw new IdentityError(400, 'OUTCOME_INVALID');
    const patch = {
      verifiedCountries, pendingCountries: [],
      decision: { ...(v.decision || {}), outcome: 'approved', reasonCodes: [], by, at: now(), note: code ? `${code}${note ? ` : ${note}` : ''}` : note },
    };
    const updated = await store.updateVerification(v._id, patch, { push: { accessLog: { adminId: String(adminId), action: `pending:${outcome}`, fileId: null, at: now() } } });
    await store.deleteFilesOf(v._id);
    return { status: updated.status, verifiedCountries: updated.verifiedCountries };
  }

  /** La société a-t-elle une vérification d'identité enregistrée (tout statut) ? Sert à reconnaître un profil Nomad Solo sans abonnement. */
  async function hasRecord(companyId) {
    return (await store.listForCompany(companyId)).length > 0;
  }

  return { status, upload, removeFile, submit, process, requestReview, recoverStale, verifiedCountriesFor, hasRecord, isStale, adminList, adminDetail, adminFile, adminDecide };
}

/** Champs extraits conservés (spec §11.1) : ni numéro de document, ni lignes MRZ, ni adresse complète. */
function minimize(id, proof, facts) {
  return {
    facts: facts || null,
    id: id ? {
      documentType: id.document_type, issuingCountryIso3: id.issuing_country_iso3, nationalityIso3: id.nationality_iso3,
      lastName: id.last_name_latin, givenNames: id.given_names_latin, lastNameNative: id.last_name_native, givenNamesNative: id.given_names_native,
      expiryDate: id.expiry_date, legibility: id.legibility, mrzPresent: Array.isArray(id.mrz_lines) && id.mrz_lines.length > 0, observations: id.observations,
    } : null,
    proof: proof ? {
      documentType: proof.document_type, issuerName: proof.issuer_name, holderName: proof.holder_name, holderNameNative: proof.holder_name_native,
      city: proof.city, countryPrinted: proof.country_printed, countryInferred: proof.country_iso2_inferred, inferenceBasis: proof.country_inference_basis,
      issueDate: proof.issue_date, legibility: proof.legibility, observations: proof.observations,
    } : null,
  };
}

let shared = null;
/** Service partagé de l'application (base Mongo), créé à la première utilisation. */
export async function identityService() {
  if (!shared) {
    const { createMongoStore } = await import('./store.js');
    shared = createIdentityService({ store: await createMongoStore() });
  }
  return shared;
}
