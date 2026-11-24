import mongoose from 'mongoose';
import { AppLinkSmsCounter } from '../../models/AppLinkSmsCounter.js';

const isDup = (e) => e?.code === 11000;

/** Accès aux données : compteurs atomiques et mobile du compte (collection users du service d'inscription). */
export const mongoAppLinkStore = {
  /** +1 seulement sous `limit` ; false si la limite est atteinte. */
  async bump(key, limit, expiresAt) {
    try {
      return Boolean(await AppLinkSmsCounter.findOneAndUpdate({ _id: key, n: { $lt: limit } }, { $inc: { n: 1 }, $setOnInsert: { expiresAt } }, { upsert: true, new: true }).lean());
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
  },
  async unbump(key) { await AppLinkSmsCounter.updateOne({ _id: key, n: { $gt: 0 } }, { $inc: { n: -1 } }); },
  /** { phone, isVerified } du compte, ou null. */
  async findUser(userId) {
    if (!/^[0-9a-f]{24}$/i.test(String(userId || ''))) return null;
    return mongoose.connection.db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(String(userId)) }, { projection: { phone: 1, isVerified: 1 } });
  },
};
