import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'human_agent'], required: true },
  text: { type: String, default: '' },
  wamid: { type: String, default: null },
  lang: { type: String, default: null },
  ts: { type: Date, default: Date.now },
}, { _id: false });

const conversationSchema = new mongoose.Schema({
  /** Identifiant WhatsApp de l'utilisateur (son numéro, E.164 sans « + ») : fourni et authentifié par WhatsApp. */
  waId: { type: String, required: true, unique: true, index: true },
  profileName: { type: String, default: '' },
  language: { type: mongoose.Schema.Types.Mixed, default: null },
  /** Compte HARX lié (preuve : code à usage unique émis à un utilisateur connecté). Jamais déduit d'un simple numéro. */
  linkedUserId: { type: String, default: null, index: true },
  linkedAt: { type: Date, default: null },
  messages: { type: [messageSchema], default: [] },
  notes: { type: [new mongoose.Schema({ key: String, value: String, at: { type: Date, default: Date.now } }, { _id: false })], default: [] },
  handoff: { type: mongoose.Schema.Types.Mixed, default: { active: false } },
  lastInboundAt: { type: Date, default: null },
}, { timestamps: true, collection: 'whatsapp_conversations' });

const processedSchema = new mongoose.Schema({
  wamid: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 3600 },
}, { collection: 'whatsapp_processed_messages' });

const linkCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'whatsapp_link_codes' });

const ticketSchema = new mongoose.Schema({
  waId: { type: String, required: true, index: true },
  linkedUserId: { type: String, default: null },
  reason: { type: String, default: '' },
  summary: { type: String, default: '' },
  urgency: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  language: { type: String, default: '' },
  status: { type: String, enum: ['open', 'in_progress', 'resolved'], default: 'open', index: true },
  transcript: { type: [messageSchema], default: [] },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'whatsapp_support_tickets' });

export const WhatsAppConversation = mongoose.models.WhatsAppConversation || mongoose.model('WhatsAppConversation', conversationSchema);
export const WhatsAppProcessed = mongoose.models.WhatsAppProcessed || mongoose.model('WhatsAppProcessed', processedSchema);
export const WhatsAppLinkCode = mongoose.models.WhatsAppLinkCode || mongoose.model('WhatsAppLinkCode', linkCodeSchema);
export const WhatsAppTicket = mongoose.models.WhatsAppTicket || mongoose.model('WhatsAppTicket', ticketSchema);
