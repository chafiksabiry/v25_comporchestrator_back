/**
 * Textes que le serveur écrit pour les MEMBRES de la société (e-mail « message pris à l'accueil », notifications push, titre d'un message
 * pris) : ils suivent la règle du fondateur du 21/11/2026 (« English must be the native language and French only for French-speaking
 * countries ») : français si la société est d'un pays francophone (langue de la société, `companyLanguage` / `languageForPhone`), anglais
 * sinon. Le serveur ne connaît pas la langue de l'appareil de la personne : l'espagnol et l'arabe, qui n'en dépendent que, ne sont donc pas
 * utilisés ici (à faire le jour où la langue choisie dans l'application sera enregistrée avec le profil ou l'abonnement push).
 * Les phrases dites aux APPELANTS restent dans `companyLanguage.js` (PHRASES, langue du pays du numéro, 8 langues).
 */
export const STAFF_LANGUAGES = ['fr', 'en'];

/** Langue des textes destinés aux membres : « fr » pour une société francophone, « en » pour toute autre langue ou une langue inconnue. */
export const staffLanguage = (companyLanguage) => (String(companyLanguage ?? '').trim().toLowerCase().slice(0, 2) === 'fr' ? 'fr' : 'en');

export const STAFF_TEXTS = Object.freeze({
  fr: {
    locale: 'fr-FR',
    reception: 'Accueil',
    unknownCaller: 'Un appelant',
    hiddenNumber: 'Numéro masqué',
    messageTitle: (forName, urgent) => `${urgent ? 'URGENT · ' : ''}Message pour ${forName}`,
    messageSubject: ({ escalation, urgent, callerName }) => `${escalation ? 'RELANCE · ' : ''}${urgent ? 'URGENT · ' : ''}Message de ${callerName}`,
    hello: (name) => `Bonjour ${name},`,
    escalation: (forName) => `RELANCE : ce message destiné à ${forName} n’a pas été traité dans le délai prévu. Merci de vous en assurer.`,
    takenAt: ({ urgent, companyName, takenByName }) => `${urgent ? 'Message URGENT' : 'Message'} pris à l’accueil${companyName ? ` de ${companyName}` : ''}${takenByName ? ` par ${takenByName}` : ''}.`,
    caller: (name, company) => `Appelant : ${name}${company ? ` (${company})` : ''}`,
    number: (n) => `Numéro : ${n}`,
    callbackBefore: (when) => `À rappeler avant : ${when}`,
    messageLabel: 'Message :',
    findIt: 'Retrouvez ce message dans « Demandes à traiter » de votre application.',
    pushCallTitle: 'Appel entrant sur votre ligne',
    pushCallBody: (who, to) => `${who}${to ? ` → ${to}` : ''}. Touchez pour répondre ; sinon votre mobile sonne si le renvoi est activé.`,
    pushVoicemailTitle: 'Nouveau message sur le répondeur',
    pushMessageReminder: 'Rappel : un message vous attend',
    pushMessageUrgent: 'Message URGENT pour vous',
    pushMessageTaken: 'Un message a été pris pour vous',
    pushMessageBody: (who) => `${who} vous demande. Touchez pour ouvrir « Demandes à traiter ».`,
  },
  en: {
    locale: 'en-US',
    reception: 'Reception',
    unknownCaller: 'A caller',
    hiddenNumber: 'Hidden number',
    messageTitle: (forName, urgent) => `${urgent ? 'URGENT · ' : ''}Message for ${forName}`,
    messageSubject: ({ escalation, urgent, callerName }) => `${escalation ? 'REMINDER · ' : ''}${urgent ? 'URGENT · ' : ''}Message from ${callerName}`,
    hello: (name) => `Hello ${name},`,
    escalation: (forName) => `REMINDER: this message for ${forName} was not handled in time. Please make sure it is taken care of.`,
    takenAt: ({ urgent, companyName, takenByName }) => `${urgent ? 'URGENT message' : 'Message'} taken at reception${companyName ? ` for ${companyName}` : ''}${takenByName ? ` by ${takenByName}` : ''}.`,
    caller: (name, company) => `Caller: ${name}${company ? ` (${company})` : ''}`,
    number: (n) => `Number: ${n}`,
    callbackBefore: (when) => `Call back before: ${when}`,
    messageLabel: 'Message:',
    findIt: 'Find this message under “To handle” in your app.',
    pushCallTitle: 'Incoming call on your line',
    pushCallBody: (who, to) => `${who}${to ? ` → ${to}` : ''}. Tap to answer; otherwise your mobile rings if forwarding is on.`,
    pushVoicemailTitle: 'New voicemail',
    pushMessageReminder: 'Reminder: a message is waiting for you',
    pushMessageUrgent: 'URGENT message for you',
    pushMessageTaken: 'A message was taken for you',
    pushMessageBody: (who) => `${who} is asking for you. Tap to open “To handle”.`,
  },
});

/** Textes pour la langue de la société (voir `staffLanguage`). */
export const staffTexts = (companyLanguage) => STAFF_TEXTS[staffLanguage(companyLanguage)];
