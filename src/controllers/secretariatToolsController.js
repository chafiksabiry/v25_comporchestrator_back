import mongoose from 'mongoose';
import SecretariatTools from '../models/SecretariatTools.js';
import FollowUpItem from '../models/FollowUpItem.js';
import { canManage } from '../services/followUps.js';
import { buildCalendarIcs } from '../services/ics.js';
import { isVisioUrl } from '../services/visio.js';
import { connectedProviders } from '../services/secretariatConnections.js';
import {
  feedTokenMatches, feedUrlFor, hashFeedToken, isFeedTokenShape, loadTools, newFeedToken, toView, validateToolsPatch,
} from '../services/secretariatTools.js';

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });
const NOT_ALLOWED = 'Seuls le titulaire et les membres autorisés à gérer les appels peuvent modifier ces réglages.';
const FEED_PAST_DAYS = 30;
const FEED_MAX_ITEMS = 500;

const companyOid = (req) => (mongoose.Types.ObjectId.isValid(req.params.companyId) ? new mongoose.Types.ObjectId(req.params.companyId) : null);

/** Écriture : titulaire ou membre autorisé (jamais un agent, jamais un appel de service sans personne). */
const mayWrite = (req) => Boolean(req.companyAccess) && canManage(req.companyAccess);

export const secretariatToolsController = {
  async get(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      res.json({ success: true, data: toView(await loadTools(companyId)) });
    } catch (error) {
      console.error('secretariat tools get:', error.message);
      fail(res, 500, 'Lecture des réglages impossible.');
    }
  },

  async update(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      if (!mayWrite(req)) return fail(res, 403, NOT_ALLOWED);
      // Les connexions ne sont lues que si le corps choisit un fournisseur externe (rien à vérifier sinon).
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const external = [b.email?.provider, b.agenda?.provider, b.visio?.provider].some((p) => typeof p === 'string' && !['platform', 'none', 'jitsi', 'custom'].includes(p));
      const checked = validateToolsPatch(req.body, await loadTools(companyId), external ? await connectedProviders(companyId) : new Set());
      if (checked.error) return fail(res, 400, checked.error);
      const doc = await SecretariatTools.findOneAndUpdate({ companyId }, { $set: checked.set }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
      res.json({ success: true, data: toView(doc) });
    } catch (error) {
      console.error('secretariat tools update:', error.message);
      fail(res, 500, 'Enregistrement des réglages impossible.');
    }
  },

  /** Crée ou régénère le jeton (l'ancien lien cesse de fonctionner). Le jeton en clair n'existe que dans la réponse. */
  async agendaFeed(req, res) {
    try {
      const companyId = companyOid(req);
      if (!companyId) return fail(res, 400, 'Identifiant de centre invalide.');
      if (!mayWrite(req)) return fail(res, 403, NOT_ALLOWED);
      const token = newFeedToken();
      const doc = await SecretariatTools.findOneAndUpdate(
        { companyId },
        { $set: { 'agendaFeed.tokenHash': hashFeedToken(token), 'agendaFeed.createdAt': new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      res.status(201).json({ success: true, data: toView(doc, feedUrlFor(token)) });
    } catch (error) {
      console.error('secretariat tools agenda-feed:', error.message);
      fail(res, 500, 'Création du lien d’abonnement impossible.');
    }
  },

  /** PUBLIC (aucune session) : le jeton fait foi. Toute anomalie répond le même 404 générique. */
  async feed(req, res) {
    const notFound = () => res.status(404).type('text/plain; charset=utf-8').send('Not found');
    try {
      const token = req.params.token;
      if (!isFeedTokenShape(token)) return notFound();
      const hash = hashFeedToken(token);
      const tools = await SecretariatTools.findOne({ 'agendaFeed.tokenHash': hash }).select('companyId visio agendaFeed').lean();
      if (!tools || !feedTokenMatches(tools.agendaFeed?.tokenHash, token)) return notFound();

      // Seuls les champs utiles au calendrier sont lus : ni e-mail, ni téléphone, ni note du contact.
      const rows = await FollowUpItem.find({
        companyId: tools.companyId, model: 'appointment', dueAt: { $gte: new Date(Date.now() - FEED_PAST_DAYS * 86400000) },
      }).sort({ dueAt: 1 }).limit(FEED_MAX_ITEMS).select('title dueAt durationMinutes status videoUrl videoProvider sequence createdAt updatedAt').lean();
      const customUrl = tools.visio?.provider === 'custom' ? tools.visio.customUrl : '';
      const items = rows.map((r) => ({
        id: String(r._id), title: r.title, dueAt: r.dueAt, durationMinutes: r.durationMinutes, status: r.status, sequence: r.sequence,
        createdAt: r.createdAt, updatedAt: r.updatedAt, videoUrl: isVisioUrl(r.videoUrl, customUrl, r.videoProvider) ? r.videoUrl : '',
      }));
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.status(200).send(buildCalendarIcs(items));
    } catch (error) {
      console.error('secretariat agenda feed:', error.message); // jamais le jeton
      res.status(500).type('text/plain; charset=utf-8').send('Error');
    }
  },
};
