import mongoose from 'mongoose';
import { PhoneNumber } from '../models/PhoneNumber.js';

/**
 * Ligne d'accueil d'une entreprise : son nom et le(s) numéro(s) sur lesquels arrivent ses appels. Lecture seule, destinée à
 * tout membre rattaché (titulaire, responsable, secrétaire) : ne renvoie JAMAIS que l'entreprise demandée et aucun champ
 * de facturation ni d'opérateur.
 */

const DEAD = new Set(['cancelled', 'released', 'terminated', 'failed', 'deleted']);

/** 'active' : reçoit les appels ; 'suspended' : ligne suspendue (impayé) ; 'pending' : en cours d'activation. */
export function lineStatus(n) {
  const st = String(n?.status || '').toLowerCase();
  const billing = String(n?.billingStatus || '');
  if (billing === 'suspended' || billing === 'payment_failed') return 'suspended';
  return st === 'active' ? 'active' : 'pending';
}

/** Numéros affichables : sans ligne libérée ou annulée, les plus anciens d'abord (la première ligne reste la ligne principale). */
export function toReceptionNumbers(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((n) => n && typeof n.phoneNumber === 'string' && n.phoneNumber && !DEAD.has(String(n.status || '').toLowerCase()) && String(n.billingStatus || '') !== 'terminated')
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
    .map((n) => {
      const label = typeof n.label === 'string' ? n.label.trim() : typeof n.metadata?.label === 'string' ? n.metadata.label.trim() : '';
      return { phoneNumber: n.phoneNumber, ...(label ? { label: label.slice(0, 80) } : {}), status: lineStatus(n) };
    });
}

/** @param {{ collection: (name: string) => any }} [db] */
export async function loadReceptionLine(companyId, { db = mongoose.connection.db, Phone = PhoneNumber } = {}) {
  const oid = mongoose.isValidObjectId(String(companyId)) ? new mongoose.Types.ObjectId(String(companyId)) : null;
  if (!oid) return { companyName: '', numbers: [] };
  const [company, rows] = await Promise.all([
    db.collection('companies').findOne({ _id: oid }, { projection: { name: 1 } }),
    Phone.find({ companyId: oid }).select('phoneNumber status billingStatus createdAt metadata.label').lean(),
  ]);
  return { companyName: String(company?.name || '').trim().slice(0, 160), numbers: toReceptionNumbers(rows) };
}
