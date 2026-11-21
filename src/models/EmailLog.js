import mongoose from 'mongoose';

/**
 * Journal des e-mails envoyés depuis le secrétariat : qui, à qui, quand, objet. Lié à l'élément « À traiter » d'origine quand il existe.
 * Le CONTENU (texte envoyé, nom / taille / type des pièces jointes) n'est pas ici : il est conservé à part, 90 jours, dans EmailContent
 * (collection `secretariat_email_content`, index TTL), lisible par la seule personne qui a envoyé l'e-mail. Avant la mise en service de cette
 * conservation (décision du fondateur, novembre 2026), le contenu n'était pas conservé du tout.
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    sentById: { type: String, required: true },
    sentByName: { type: String, default: '' },
    to: { type: [String], default: [] },
    subject: { type: String, required: true, maxlength: 150 },
    template: { type: String, default: 'free' },
    followUpId: { type: mongoose.Schema.Types.ObjectId, default: null },
    withIcs: { type: Boolean, default: false },
    /** Envoi depuis un compte partagé (boîte d'un patron / collègue) : compte, adresse d'expédition et libellé au moment de l'envoi. Absent = boîte de la société. */
    accountId: { type: mongoose.Schema.Types.ObjectId, default: null },
    fromEmail: { type: String, default: '', maxlength: 254 },
    fromLabel: { type: String, default: '', maxlength: 80 },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    /** Motif court d'échec (jamais le contenu du message). */
    error: { type: String, default: '', maxlength: 200 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'secretariat_email_log' }
);

schema.index({ companyId: 1, createdAt: -1 });
schema.index({ companyId: 1, followUpId: 1, createdAt: -1 });

export default mongoose.models.EmailLog || mongoose.model('EmailLog', schema);
