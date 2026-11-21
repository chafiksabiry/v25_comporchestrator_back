import mongoose from 'mongoose';

/** Durée de conservation du contenu d'un e-mail envoyé depuis HARX (décision du fondateur : 90 jours). */
export const EMAIL_CONTENT_TTL_DAYS = 90;
export const EMAIL_CONTENT_TTL_SECONDS = EMAIL_CONTENT_TTL_DAYS * 24 * 3600;
/** Texte conservé au plus (au-delà : coupé, `truncated: true`). */
export const EMAIL_CONTENT_MAX_CHARS = 20_000;

/**
 * CONTENU d'un e-mail envoyé depuis le secrétariat, séparé du journal (EmailLog) : le journal garde sa propre durée de conservation, le contenu
 * disparaît seul 90 jours après l'envoi (index TTL sur `sentAt`, purge MongoDB au plus ~60 s après l'échéance ; la lecture revérifie la date).
 *
 * - `text` : le texte envoyé (version texte, signature comprise), jamais le HTML (mis en forme seulement à l'envoi) ; 20 000 caractères au plus.
 * - `attachments` : NOM, TAILLE et TYPE des pièces jointes seulement, jamais leur contenu. Le fichier agenda (.ics) n'est pas repris (drapeau
 *   `withIcs` du journal, régénéré depuis le rendez-vous).
 * - Lecture : la personne qui a envoyé l'e-mail (`sentById`), dans la même société (`companyId`), et personne d'autre (titulaire compris).
 *
 * `bufferCommands: false` : sans connexion à la base, l'écriture échoue tout de suite au lieu d'attendre ; elle n'empêche jamais l'envoi.
 */
const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', maxlength: 200 },
    size: { type: Number, default: 0, min: 0 },
    type: { type: String, default: '', maxlength: 200 },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    logId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailLog', required: true, unique: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    sentById: { type: String, required: true },
    text: { type: String, default: '', maxlength: EMAIL_CONTENT_MAX_CHARS },
    truncated: { type: Boolean, default: false },
    attachments: { type: [attachmentSchema], default: [] },
    /** Date d'envoi (= `createdAt` de l'entrée du journal) : point de départ des 90 jours. */
    sentAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'secretariat_email_content', bufferCommands: false }
);

schema.index({ sentAt: 1 }, { expireAfterSeconds: EMAIL_CONTENT_TTL_SECONDS });

export default mongoose.models.EmailContent || mongoose.model('EmailContent', schema);
