/** Nettoyage du texte des e-mails entrants (extraits, objets, corps lus en direct). Aucune donnée n'est journalisée ni conservée ici. */
export const BODY_MAX = 20_000;
export const SNIPPET_MAX = 200;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', agrave: 'à', ecirc: 'ê', ccedil: 'ç', rsquo: '’', lsquo: '‘', hellip: '…', ndash: '–', mdash: '—' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Extrait court : entités décodées, espaces réduits, 200 caractères au plus. */
export const cleanSnippet = (v) => decodeEntities(String(v ?? '')).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
/** Objet ou nom : une ligne, sans caractère de contrôle, 300 caractères au plus. */
export const cleanSubject = (v) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

/** « "Nom" <a@b.fr> », « Nom <a@b.fr> » ou « a@b.fr » -> { name, email } (adresse en minuscules ; vide si illisible). */
export function parseAddress(v) {
  const raw = String(v ?? '').replace(CONTROL, ' ').trim();
  const m = raw.match(/<([^<>\s]+@[^<>\s]+)>/) || raw.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  const email = m ? m[1].toLowerCase().slice(0, 254) : '';
  const name = raw.replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 120);
  return { name: name.includes('@') && name.toLowerCase() === email ? '' : name, email };
}

/** HTML -> texte : scripts / styles / commentaires retirés, blocs en retours à la ligne, balises supprimées, entités décodées. */
export function htmlToText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(CONTROL, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const QUOTE_START = [
  /\n(?:Le|On) [^\n]{3,250}(?:\n[^\n]{0,250})?(?:a écrit|wrote)\s*:\s*(?:\n|$)/i,
  /\n-{2,}\s*(?:Original Message|Message d'origine|Message original|Forwarded message)[^\n]*-{0,}\s*(?:\n|$)/i,
  /\n_{10,}\s*\n\s*(?:De|From)\s*:/i,
  /\n(?:De|From)\s*:[^\n]*\n(?:Envoyé|Sent|Date)\s*:/i,
];

/** Historique cité tronqué : lignes « > » retirées, coupure au premier en-tête de citation (Le … a écrit :, On … wrote:, Message d'origine, De : / Envoyé :). */
export function stripQuoted(text) {
  const t = `\n${String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '')}`;
  let end = t.length;
  for (const re of QUOTE_START) { const m = re.exec(t); if (m && m.index < end) end = m.index; }
  const kept = t.slice(0, end).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept || t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
}

/** 20 000 caractères au plus (le dernier est « … » en cas de coupure). */
export const limitBody = (text) => (text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text);
