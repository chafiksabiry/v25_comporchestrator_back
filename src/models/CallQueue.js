import mongoose from 'mongoose';

/**
 * File d'attente d'un centre (écran « Répartition des appels »). Plusieurs par centre.
 * La validation complète (langues, compétences, touches, file par défaut unique) est faite dans services/callQueues.js :
 * l'unicité de la touche et de la file par défaut n'est PAS garantie par un index (un échange de touches entre deux files
 * ne passerait pas un index unique pendant le remplacement).
 */
const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
    strategy: { type: String, enum: ['simultaneous', 'longest_idle', 'round_robin'], default: 'simultaneous' },
    /** Codes ISO 639-1 en minuscules (liste fermée : services/routingLanguages.js). */
    languages: { type: [String], default: [] },
    /** Étiquettes normalisées (trim, minuscules, ≤ 24 caractères, 12 au plus). */
    skills: { type: [String], default: [] },
    /** Une seule file entrante par défaut par centre. */
    isDefault: { type: Boolean, default: false },
    /** Touche du menu vocal, '1'..'9' ou null. */
    menuKey: { type: String, enum: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], default: null },
    /** Texte lu dans le menu vocal (≤ 160 caractères ; vide = texte par défaut selon la langue). */
    prompt: { type: String, default: '', maxlength: 160 },
    /** Langue du texte ('' = première langue de la file, sinon 'fr'). */
    promptLanguage: { type: String, default: '' },
    /** Curseur de la stratégie « round_robin » (incrémenté atomiquement à chaque appel). */
    rrCursor: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'call_queues' }
);

schema.index({ companyId: 1 });

export default mongoose.models.CallQueue || mongoose.model('CallQueue', schema);
