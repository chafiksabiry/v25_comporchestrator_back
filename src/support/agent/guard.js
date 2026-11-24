/**
 * Garde-fou de SORTIE : contrôle chaque texte avant qu'il puisse partir vers un client (brouillon comme envoi autonome).
 * Une seule violation suffit : le texte n'est jamais envoyé, la demande est escaladée au fondateur (en cas de doute, on escalade).
 *
 *  - secret            : clé d'API, jeton, mot de passe, clé privée (formats Anthropic, Stripe, Brevo, Twilio, Meta, JWT, AWS…)
 *  - identity_document : ligne MRZ, numéro de pièce, empreinte de document (jamais de pièce d'identité dans une réponse)
 *  - technical_id      : identifiant interne (société, Stripe, Mongo) : jamais exposé
 *  - other_contact     : numéro ou e-mail qui n'est ni celui du client, ni celui du support (donnée d'un autre client)
 *  - account_unverified: donnée du compte citée alors que l'identité du demandeur n'est pas prouvée (canal non lié)
 */
const SECRET_RES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/, /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/, /\bwhsec_[A-Za-z0-9]{8,}/, /xkeysib-[A-Za-z0-9-]{8,}/, /xsmtpsib-[A-Za-z0-9-]{8,}/,
  /\bAC[0-9a-f]{32}\b/, /\bSK[0-9a-f]{32}\b/, /\bEAA[A-Za-z0-9]{20,}/, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{20,}/, /\bya29\.[A-Za-z0-9_-]{10,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b(api[_ -]?key|secret|token|password|mot de passe|contrase[nñ]a|كلمة السر)\s*[:=]\s*\S{6,}/i,
];
const IDENTITY_RES = [
  /\b[PIACV][A-Z<][A-Z<]{3}[A-Z0-9<]{20,}/, // ligne MRZ (P<FRA..., IDFRA...)
  /[A-Z0-9<]{25,}<<[A-Z0-9<]*/, // remplissage MRZ
  /(num[ée]ro|n°|no\.?|number|n[uú]mero)\s+(de\s+|du\s+|of\s+(your\s+)?|del\s+)?(passeport|passport|pasaporte|pi[eè]ce d'identit[ée]|carte d'identit[ée]|id card|dni|document)\s*[:\-]?\s*[A-Z0-9]{6,}/i,
  /رقم (جواز|البطاقة|الهوية)\s*[:\-]?\s*[A-Z0-9]{6,}/,
];
const TECH_ID_RES = [/\b[0-9a-f]{24}\b/i, /\b(cus|sub|in|pi|pm|price|prod|seti|cs|si|ii|bpc|acct)_[A-Za-z0-9]{8,}/, /\bPN[0-9a-f]{32}\b/, /\bCA[0-9a-f]{32}\b/];
const PHONE_RE = /(?:\+|00)?\d[\d\s.()-]{7,}\d/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * @param {string} text
 * @param {{allowedEmails?: string[], allowedPhones?: string[], verified?: boolean, accountFacts?: string[]}} ctx
 * @returns {{ok: boolean, violations: Array<{kind: string, sample: string}>}}  sample : extrait MASQUÉ (jamais la valeur entière)
 */
export function checkOutgoing(text, { allowedEmails = [], allowedPhones = [], verified = false, accountFacts = [] } = {}) {
  const s = String(text || '');
  const violations = [];
  const masked = (v) => { const x = String(v); return x.length <= 6 ? '***' : `${x.slice(0, 3)}…${x.slice(-2)}`; };
  for (const re of SECRET_RES) { const m = re.exec(s); if (m) violations.push({ kind: 'secret', sample: masked(m[0]) }); }
  for (const re of IDENTITY_RES) { const m = re.exec(s); if (m) violations.push({ kind: 'identity_document', sample: masked(m[0]) }); }
  for (const re of TECH_ID_RES) { const m = re.exec(s); if (m) violations.push({ kind: 'technical_id', sample: masked(m[0]) }); }
  const okEmails = new Set(allowedEmails.map((e) => String(e).toLowerCase()));
  for (const m of s.matchAll(EMAIL_RE)) if (!okEmails.has(m[0].toLowerCase())) violations.push({ kind: 'other_contact', sample: masked(m[0]) });
  const okPhones = allowedPhones.map(digits).filter((d) => d.length >= 6);
  for (const m of s.matchAll(PHONE_RE)) {
    const d = digits(m[0]);
    if (d.length < 8 || d.length > 15) continue; // montants, dates, durées
    if (!okPhones.some((p) => p.endsWith(d) || d.endsWith(p))) violations.push({ kind: 'other_contact', sample: masked(d) });
  }
  if (!verified) {
    for (const fact of accountFacts) {
      const f = String(fact || '').trim();
      if (f.length >= 4 && s.toLowerCase().includes(f.toLowerCase())) violations.push({ kind: 'account_unverified', sample: masked(f) });
    }
  }
  return { ok: violations.length === 0, violations };
}
