import mongoose from 'mongoose';

/**
 * Durable notification shown in the company header bell (same idea as the REP notifications).
 * `key` makes ingestion idempotent: the same business event notified twice creates one row.
 */
const companyNotificationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    key: { type: String, required: true },
    kind: {
      type: String,
      enum: ['enrollment_request', 'enrollment_accepted', 'enrollment_rejected', 'wallet', 'tokens', 'minutes', 'phone', 'subscription', 'info'],
      default: 'info',
    },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    gigId: { type: String, default: null },
    /** In-app route to open when the notification is clicked (hash-router path). */
    actionPath: { type: String, default: null },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

companyNotificationSchema.index({ companyId: 1, key: 1 }, { unique: true });

export default mongoose.model('CompanyNotification', companyNotificationSchema);
