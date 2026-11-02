/**
 * Export iCalendar (RFC 5545) d'un rendez-vous interne HARX. Logique pure : aucun accès base ni réseau.
 *  - lignes terminées par CRLF et repliées à 75 octets (UTF-8, sans couper un caractère) ;
 *  - texte échappé (`\`, `;`, `,` et retours à la ligne) ;
 *  - UID stable (identifiant de l'élément) : réimporter le fichier met à jour l'événement au lieu d'en créer un autre ;
 *  - fuseau Europe/Paris explicite (VTIMEZONE avec règles d'heure d'été) ; SEQUENCE croissant à chaque déplacement.
 */
export const ICS_TIMEZONE = 'Europe/Paris';
export const ICS_UID_DOMAIN = 'harx.ai';
const CRLF = '\r\n';

const VTIMEZONE_PARIS = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** Échappement d'une valeur TEXT (RFC 5545, 3.3.11). */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Replie une ligne à 75 octets au plus (UTF-8), la suite commençant par une espace. */
export function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = 74; // la ligne de continuation commence par une espace
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Date UTC au format `20261103T090000Z`. */
export function formatUtc(date) {
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const PARIS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ICS_TIMEZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Heure murale de Paris au format `20261103T100000` (sans « Z »). */
export function formatParis(date) {
  const p = Object.fromEntries(PARIS.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/** Nom de fichier proposé au téléchargement. */
export function icsFilename(item) {
  const d = new Date(item.dueAt);
  const stamp = Number.isNaN(d.getTime()) ? 'rendez-vous' : formatParis(d).slice(0, 13).replace('T', '-');
  return `rendez-vous-${stamp}.ics`;
}

export const icsUid = (item) => `${String(item.id)}@${ICS_UID_DOMAIN}`;

/**
 * @param {{id: string, title: string, note?: string, contactName?: string, contactPhone?: string, dueAt: string|Date,
 *          durationMinutes?: number|null, status?: string, videoUrl?: string, sequence?: number, updatedAt?: string|Date,
 *          createdAt?: string|Date, assignee?: {name?: string}}} item vue de l'élément (voir `toItem`)
 * @returns {string} contenu du fichier .ics
 */
export function buildAppointmentIcs(item) {
  const start = new Date(item.dueAt || NaN);
  if (!item.id || Number.isNaN(start.getTime())) throw new Error('Rendez-vous sans date : export impossible.');
  const minutes = Number.isFinite(Number(item.durationMinutes)) && Number(item.durationMinutes) > 0 ? Number(item.durationMinutes) : 30;
  const end = new Date(start.getTime() + minutes * 60_000);
  const stampSource = new Date(item.updatedAt || item.createdAt || start);
  const stamp = Number.isNaN(stampSource.getTime()) ? start : stampSource;
  const canceled = item.status === 'canceled';

  const description = [
    item.contactName ? `Rendez-vous avec ${item.contactName}.` : '',
    item.contactPhone ? `Téléphone : ${item.contactPhone}` : '',
    item.assignee?.name ? `En charge : ${item.assignee.name}` : '',
    item.videoUrl ? `Visio : ${item.videoUrl}` : '',
    item.note ? `Note : ${item.note}` : '',
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HARX//Call Centre Agenda//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...VTIMEZONE_PARIS,
    'BEGIN:VEVENT',
    `UID:${icsUid(item)}`,
    `DTSTAMP:${formatUtc(stamp)}`,
    `DTSTART;TZID=${ICS_TIMEZONE}:${formatParis(start)}`,
    `DTEND;TZID=${ICS_TIMEZONE}:${formatParis(end)}`,
    `SEQUENCE:${Math.max(0, Math.floor(Number(item.sequence) || 0))}`,
    `SUMMARY:${escapeText(item.title || 'Rendez-vous')}`,
    ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
    ...(item.videoUrl ? [`LOCATION:${escapeText(item.videoUrl)}`, `URL:${item.videoUrl}`] : []),
    `STATUS:${canceled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    ...(canceled ? [] : ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Rappel de rendez-vous', 'TRIGGER:-PT15M', 'END:VALARM']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(CRLF) + CRLF;
}
