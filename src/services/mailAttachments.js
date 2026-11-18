import multer from 'multer';

/**
 * Pièces jointes des e-mails écrits depuis HARX (nouvel e-mail, réponse, réponse à tous, transfert).
 *
 * CONFIDENTIALITÉ : une pièce jointe n'est JAMAIS stockée. Elle est reçue en mémoire (multer memoryStorage : aucun fichier temporaire sur disque),
 * vérifiée, encodée pour le fournisseur (Gmail / Outlook) puis abandonnée à la fin de la requête. Ni son nom, ni son type, ni son contenu ne sont
 * écrits en base, dans le journal d'envoi (EmailLog) ou dans les journaux du serveur.
 *
 * Limites (communes) : 10 fichiers, 10 Mio par fichier, 20 Mio au total. Limites RÉELLES par fournisseur (plus strictes) :
 *  - Gmail : le message complet (pièces encodées en base64, +37 % avec les retours à la ligne) doit rester sous 25 Mo → 17 Mio de pièces au total
 *    (≈ 24,4 Mo encodés, marge pour le texte et les en-têtes). Envoi par le point d'upload `uploadType=media` (le champ JSON `raw` est limité à
 *    quelques Mo).
 *  - Outlook (Graph `POST /me/sendMail`) : pièces « en ligne » seulement, et la requête Graph est limitée à 4 Mio → 3 Mo (3 000 000 octets) par
 *    fichier ET au total. Une session d'upload (pièces plus grosses) exigerait de créer un brouillon, donc le droit Mail.ReadWrite, qui n'est pas
 *    demandé pour l'envoi : non retenu.
 */
export const MiB = 1024 * 1024;
export const ATTACHMENT_LIMITS = Object.freeze({ maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 20 * MiB });
const PROVIDER_LIMITS = {
  google: { maxFiles: 10, maxFileBytes: 10 * MiB, maxTotalBytes: 17 * MiB },
  microsoft: { maxFiles: 10, maxFileBytes: 3_000_000, maxTotalBytes: 3_000_000 },
};
/** Limites effectives pour un fournisseur (les plus strictes entre limites communes et limites du fournisseur). */
export function limitsFor(provider) {
  const p = PROVIDER_LIMITS[provider] || ATTACHMENT_LIMITS;
  return {
    maxFiles: Math.min(p.maxFiles, ATTACHMENT_LIMITS.maxFiles),
    maxFileBytes: Math.min(p.maxFileBytes, ATTACHMENT_LIMITS.maxFileBytes),
    maxTotalBytes: Math.min(p.maxTotalBytes, ATTACHMENT_LIMITS.maxTotalBytes),
    blockedExtensions: BLOCKED_EXTENSIONS,
  };
}

/** Extensions refusées (exécutables, scripts, installeurs, raccourcis, macros…), comparées sans tenir compte de la casse. */
export const BLOCKED_EXTENSIONS = Object.freeze([
  'exe', 'bat', 'cmd', 'com', 'js', 'jse', 'vbs', 'vbe', 'vb', 'wsf', 'wsh', 'ws', 'wsc', 'scr', 'msi', 'msp', 'mst', 'jar', 'ps1', 'ps1xml', 'ps2',
  'psc1', 'psm1', 'psd1', 'pif', 'cpl', 'hta', 'reg', 'lnk', 'inf', 'scf', 'gadget', 'application', 'msc', 'dll', 'sys', 'drv', 'ocx', 'sh', 'bash',
  'csh', 'ksh', 'command', 'app', 'apk', 'appx', 'msix', 'appxbundle', 'dmg', 'pkg', 'deb', 'rpm', 'iso', 'img', 'vhd', 'vhdx', 'xll', 'chm', 'url',
  'library-ms', 'settingcontent-ms', 'mjs', 'cjs', 'py', 'pyc', 'pyw', 'pl', 'rb', 'php', 'elf', 'bin', 'run', 'class', 'xbap', 'appref-ms', 'ade', 'adp',
  // documents Office à macros, pages web et images vectorielles (scripts intégrés), OneNote, archives d'installation
  'docm', 'xlsm', 'pptm', 'xlam', 'dotm', 'potm', 'ppam', 'xltm', 'sldm', 'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'one', 'onepkg', 'cab',
]);
const BLOCKED_SET = new Set(BLOCKED_EXTENSIONS);
/** Types MIME déclarés refusés. */
const BLOCKED_TYPES = new Set([
  'application/x-msdownload', 'application/x-msdos-program', 'application/x-dosexec', 'application/x-executable', 'application/x-ms-installer',
  'application/x-msi', 'application/x-ms-shortcut', 'application/vnd.microsoft.portable-executable', 'application/x-bat', 'application/x-sh',
  'application/x-csh', 'application/x-shellscript', 'application/javascript', 'application/x-javascript', 'text/javascript', 'application/ecmascript',
  'text/vbscript', 'application/x-vbscript', 'application/hta', 'application/java-archive', 'application/x-java-archive', 'application/java-vm',
  'application/x-elf', 'application/x-mach-binary', 'application/x-apple-diskimage', 'application/vnd.android.package-archive', 'application/x-powershell',
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/vnd.ms-cab-compressed', 'application/onenote', 'application/x-iso9660-image',
  'application/vnd.ms-word.document.macroenabled.12', 'application/vnd.ms-excel.sheet.macroenabled.12', 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-excel.addin.macroenabled.12', 'application/vnd.ms-word.template.macroenabled.12', 'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.addin.macroenabled.12',
]);

export class AttachmentError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

const fmt = (bytes) => (bytes % MiB === 0 ? `${bytes / MiB} Mo` : `${(bytes / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`);
const ERR = {
  too_many: (l) => new AttachmentError('too_many_attachments', `${l.maxFiles} pièces jointes au maximum par e-mail.`, 400),
  too_large: (l) => new AttachmentError('attachment_too_large', `Une pièce jointe dépasse la taille maximale (${fmt(l.maxFileBytes)} par fichier pour cette messagerie).`, 413),
  total: (l) => new AttachmentError('attachments_total_too_large', `Les pièces jointes dépassent la taille totale autorisée (${fmt(l.maxTotalBytes)} pour cette messagerie).`, 413),
  blocked: () => new AttachmentError('attachment_type_blocked', 'Ce type de fichier ne peut pas être envoyé (programme, script, installeur, document à macros ou page web).', 415),
  invalid: () => new AttachmentError('invalid_attachment', 'Pièce jointe invalide.', 400),
};

/**
 * Nom de fichier sûr pour un en-tête MIME : sans chemin, sans caractère de contrôle (CR/LF), sans guillemet ni caractère interdit par Windows,
 * sans point ou espace final (« facture.exe. » → « facture.exe »), 150 caractères au plus (extension conservée).
 */
/** Caractères invisibles (largeur nulle, contrôle bidi) retirés AVANT de lire l'extension : « facture\u202Efdp.exe », « virus.e\u200Bxe ». */
const INVISIBLE = /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u180E]/g;
export function sanitizeFilename(input) {
  let s = String(input ?? '').normalize('NFC');
  s = s.split(/[\\/]/).pop();
  s = s.replace(INVISIBLE, '').replace(/[\u0000-\u001F\u007F-\u009F"'`<>:*?|;]+/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');
  if (s.length > 150) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, 150 - ext.length).trim() + ext;
  }
  return s || 'piece-jointe';
}

const extensionOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

/** Type réel d'après les premiers octets (signatures connues). `executable: true` = programme, quel que soit le nom. */
export function sniff(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
  const starts = (...bytes) => bytes.every((x, i) => b[i] === x);
  const head = b.subarray(0, 2048).toString('latin1');
  if (starts(0x4d, 0x5a)) return { type: 'application/vnd.microsoft.portable-executable', executable: true }; // MZ : .exe/.dll/.scr…
  if (starts(0x7f, 0x45, 0x4c, 0x46)) return { type: 'application/x-elf', executable: true };
  if (starts(0xfe, 0xed, 0xfa, 0xce) || starts(0xfe, 0xed, 0xfa, 0xcf) || starts(0xce, 0xfa, 0xed, 0xfe) || starts(0xcf, 0xfa, 0xed, 0xfe)) return { type: 'application/x-mach-binary', executable: true };
  if (starts(0xca, 0xfe, 0xba, 0xbe)) return { type: 'application/java-vm', executable: true }; // classe Java / binaire Mach-O universel
  if (starts(0x23, 0x21)) return { type: 'text/x-script', executable: true }; // « #! » : script
  if (starts(0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00)) return { type: 'application/x-ms-shortcut', executable: true }; // .lnk
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    // ZIP : les documents Office (docx/xlsx/pptx) et les archives sont acceptés ; une archive Java (manifeste en tête) ne l'est pas.
    if (/META-INF\/MANIFEST\.MF/.test(head) && !/\[Content_Types\]\.xml/.test(head)) return { type: 'application/java-archive', executable: true };
    return { type: 'application/zip', executable: false };
  }
  if (starts(0x25, 0x50, 0x44, 0x46)) return { type: 'application/pdf', executable: false };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { type: 'image/png', executable: false };
  if (starts(0xff, 0xd8, 0xff)) return { type: 'image/jpeg', executable: false };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { type: 'image/gif', executable: false };
  return { type: '', executable: false };
}

const SAFE_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * Vérifie et prépare les fichiers reçus (multer : `{originalname, mimetype, buffer, size}`) pour un fournisseur.
 * @returns {Array<{name: string, contentType: string, contentBase64: string, size: number}>}
 * @throws {AttachmentError} too_many_attachments | attachment_too_large | attachments_total_too_large | attachment_type_blocked | invalid_attachment
 */
export function prepareAttachments(files, provider) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return [];
  const l = limitsFor(provider);
  if (list.length > l.maxFiles) throw ERR.too_many(l);
  let total = 0;
  const out = [];
  for (const f of list) {
    if (!f || !Buffer.isBuffer(f.buffer)) throw ERR.invalid();
    const size = f.buffer.length;
    if (size > l.maxFileBytes) throw ERR.too_large(l);
    total += size;
    if (total > l.maxTotalBytes) throw ERR.total(l);
    const name = sanitizeFilename(f.originalname);
    const declared = String(f.mimetype || '').toLowerCase().split(';')[0].trim();
    const sniffed = sniff(f.buffer);
    if (BLOCKED_SET.has(extensionOf(name)) || BLOCKED_TYPES.has(declared) || sniffed.executable) throw ERR.blocked();
    const contentType = sniffed.type && sniffed.type !== 'application/zip' ? sniffed.type : SAFE_TYPE.test(declared) ? declared : 'application/octet-stream';
    out.push({ name, contentType, contentBase64: f.buffer.toString('base64'), size });
  }
  return out;
}

/** Corps multipart d'une requête : taille annoncée au-delà de laquelle on refuse sans rien lire (limite totale + marge pour les champs texte). */
const MAX_REQUEST_BYTES = ATTACHMENT_LIMITS.maxTotalBytes + MiB;
const TOTAL_EXCEEDED = 'ATTACHMENTS_TOTAL_EXCEEDED';

/**
 * Stockage multer EN MÉMOIRE qui compte les octets de TOUS les fichiers de la requête au fil du flux : dès que le total dépasse la limite (20 Mio),
 * le fichier en cours est abandonné et la requête refusée (413 attachments_total_too_large). Vaut aussi pour une requête sans Content-Length
 * (transfert « chunked ») : la mémoire occupée ne dépasse jamais la limite totale (+ un morceau du flux), et cela AVANT tout autre traitement.
 * Rien n'est écrit sur disque.
 */
export const countingMemoryStorage = (maxTotalBytes = ATTACHMENT_LIMITS.maxTotalBytes) => ({
  _handleFile(req, file, cb) {
    const chunks = [];
    let finished = false;
    const finish = (err, info) => { if (finished) return; finished = true; cb(err, info); };
    const onData = (chunk) => {
      req.attachmentBytes = (req.attachmentBytes || 0) + chunk.length;
      if (req.attachmentBytes > maxTotalBytes) {
        chunks.length = 0; // tampons libérés tout de suite
        file.stream.removeListener('data', onData);
        file.stream.resume(); // le reste du fichier est lu et jeté, jamais gardé
        const e = new Error('Pièces jointes trop volumineuses.'); e.code = TOTAL_EXCEEDED;
        finish(e);
        return;
      }
      chunks.push(chunk);
    };
    file.stream.on('data', onData);
    file.stream.on('error', (e) => finish(e));
    file.stream.on('end', () => { if (finished) return; const buffer = Buffer.concat(chunks); chunks.length = 0; finish(null, { buffer, size: buffer.length }); });
  },
  _removeFile(req, file, cb) { delete file.buffer; cb(null); },
});

const upload = multer({
  storage: countingMemoryStorage(), // mémoire uniquement, total compté au fil du flux : aucun fichier temporaire
  defParamCharset: 'utf8', // noms de fichiers accentués
  // +1 fichier : au-delà de 10 on renvoie too_many_attachments (pas une erreur multer générique). Champs texte bornés (30 × 64 Kio).
  limits: { files: ATTACHMENT_LIMITS.maxFiles + 1, fileSize: ATTACHMENT_LIMITS.maxFileBytes + 1, fields: 30, fieldSize: 64 * 1024, parts: 50 },
});
const parse = upload.array('attachments', ATTACHMENT_LIMITS.maxFiles + 1);

const sendAttachmentError = (res, e) => res.status(e.status).json({ success: false, code: e.code, error: e.code, message: e.message, limits: ATTACHMENT_LIMITS });

/** Champs texte d'un formulaire multipart : `to` / `cc` (répétés, JSON ou texte séparé par virgules), `attachIcs` ('true'/'false'). */
function normalizeFields(body) {
  const b = { ...body };
  for (const k of ['to', 'cc', 'references']) {
    if (typeof b[k] === 'string' && b[k].trim().startsWith('[')) { try { b[k] = JSON.parse(b[k]); } catch { /* laissé tel quel : la validation refusera */ } }
  }
  if (b.attachIcs === 'true') b.attachIcs = true; else if (b.attachIcs === 'false') b.attachIcs = false;
  return b;
}

/**
 * Intergiciel de `POST /api/emails` : JSON (inchangé, sans pièce jointe) OU multipart/form-data (champ fichier `attachments`, répété).
 * Les fichiers restent en mémoire (`req.attachmentFiles`) et ne sont vérifiés qu'APRÈS le contrôle du propriétaire de la boîte, par le contrôleur.
 */
export function receiveAttachments(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
    req.resume(); // on ne lit rien
    return sendAttachmentError(res, ERR.total(ATTACHMENT_LIMITS));
  }
  return parse(req, res, (err) => {
    if (err) {
      req.files = undefined; // rien n'est gardé
      if (err.code === TOTAL_EXCEEDED) return sendAttachmentError(res, ERR.total(ATTACHMENT_LIMITS));
      if (err.code === 'LIMIT_FILE_SIZE') return sendAttachmentError(res, ERR.too_large(ATTACHMENT_LIMITS));
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return sendAttachmentError(res, err.field && err.field !== 'attachments' ? ERR.invalid() : ERR.too_many(ATTACHMENT_LIMITS));
      return sendAttachmentError(res, ERR.invalid());
    }
    req.body = normalizeFields(req.body || {});
    req.attachmentFiles = Array.isArray(req.files) ? req.files : [];
    req.files = undefined;
    if (req.attachmentFiles.length > ATTACHMENT_LIMITS.maxFiles) { req.attachmentFiles = []; return sendAttachmentError(res, ERR.too_many(ATTACHMENT_LIMITS)); }
    // Libère les tampons à la fin de la requête, quoi qu'il arrive.
    res.on('finish', () => { req.attachmentFiles = []; });
    return next();
  });
}
