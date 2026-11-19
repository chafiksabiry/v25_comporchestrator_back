import { parseAddress } from './mailText.js';

/**
 * Liste d'adresses d'un en-tête (To / Cc / Reply-To) : « "Dupont, Jean" <j@x.fr>, b@y.fr, Groupe: c@z.fr; » → ['j@x.fr', 'b@y.fr', 'c@z.fr'].
 * Virgules entre guillemets, chevrons ou commentaires ignorées ; groupes RFC 5322 dépliés. Adresses en minuscules, dédoublonnées, 50 au plus.
 * Seules les ADRESSES sont gardées (pas les noms) : c'est tout ce qu'il faut pour répondre à tous.
 */
export function parseAddressList(header) {
  const s = String(header ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ');
  const parts = [];
  let cur = ''; let quoted = false; let angle = 0; let comment = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && quoted) { cur += c + (s[i + 1] || ''); i += 1; continue; }
    if (c === '"' && !comment) quoted = !quoted;
    else if (!quoted && c === '(') comment += 1;
    else if (!quoted && c === ')' && comment) comment -= 1;
    else if (!quoted && !comment && c === '<') angle += 1;
    else if (!quoted && !comment && c === '>' && angle) angle -= 1;
    if (!quoted && !comment && !angle && (c === ',' || c === ';')) { parts.push(cur); cur = ''; continue; }
    if (!quoted && !comment && !angle && c === ':') { cur = ''; continue; } // « Groupe: » : le nom du groupe n'est pas une adresse
    cur += c;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts) {
    const email = parseAddress(p.replace(/\([^()]*\)/g, ' ')).email;
    if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !out.includes(email)) out.push(email);
    if (out.length >= 50) break;
  }
  return out;
}
