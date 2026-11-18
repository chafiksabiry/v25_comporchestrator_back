import mongoose from 'mongoose';

/**
 * Réglages « agent IA » d'une entreprise (pilote « Téléphonie + agent IA », appels entrants). Un document par entreprise.
 * Valeurs par défaut et forme publique : services/aiAgentSettings.js. Modifiable par le TITULAIRE uniquement.
 */
const slotSchema = new mongoose.Schema({ day: { type: Number, min: 1, max: 7 }, start: String, end: String }, { _id: false });

const schema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    /** Horaires de travail de l'agent IA (plages jour / heure, format du planning de l'annuaire) ; `always` = 24 h/24, 7 j/7. */
    schedule: { always: { type: Boolean, default: false }, timeZone: { type: String, default: 'Europe/Paris' }, slots: { type: [slotSchema], default: [] } },
    /** Compétences de l'IA (étiquettes du routage des files, comme StaffRouting) ; ses langues de routage viennent de `languages`. */
    skills: { type: [String], default: [] },
    /** Priorité face aux humains : après les humains (défaut) ou en premier. */
    priority: { type: String, enum: ['after_humans', 'first'], default: 'after_humans' },
    /** Horaires d'ouverture de l'entreprise : servent seulement à proposer des créneaux de rendez-vous. */
    businessHours: { timeZone: { type: String, default: 'Europe/Paris' }, slots: { type: [slotSchema], default: undefined } },
    languages: { type: [String], default: undefined },
    voice: { type: String, enum: ['female', 'male'], default: 'female' },
    addressForm: { type: String, enum: ['vous', 'tu'], default: 'vous' },
    tone: { type: String, enum: ['professional', 'warm', 'energetic'], default: 'professional' },
    companyName: { type: String, default: '', maxlength: 80 },
    instructions: { type: String, default: '', maxlength: 4000 },
    knowledgeBase: { enabled: { type: Boolean, default: true }, gigId: { type: String, default: null } },
    actions: { appointment: { type: Boolean, default: false }, request: { type: Boolean, default: true }, transfer: { type: Boolean, default: false } },
    transferTargets: { type: [String], default: [] },
    appointment: { durationMinutes: { type: Number, default: 30 }, daysAhead: { type: Number, default: 14 } },
    maxCallMinutes: { type: Number, default: 8, min: 3, max: 15 },
    monthlyMinutesCap: { type: Number, default: 200 },
    retentionDays: { type: Number, default: 365, min: 30, max: 365 },
    listeningBench: { enabled: { type: Boolean, default: false }, provider: { type: String, default: 'alternate' } },
    updatedById: { type: String, default: '' },
  },
  { timestamps: true, collection: 'ai_agent_settings' }
);

export default mongoose.models.AiAgentSettings || mongoose.model('AiAgentSettings', schema);
