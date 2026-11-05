import mongoose from 'mongoose';

/**
 * Journal des e-mails envoyés depuis le secrétariat : qui, à qui, quand, objet. Le contenu du message n'est PAS conservé.
 * Lié à l'élément « À traiter » d'origine quand il existe.
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
