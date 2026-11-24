import { WhatsAppSendError } from './whatsappClient.js';

/**
 * Copie des échanges du chat du site vers un numéro WhatsApp de l'équipe, via l'API WhatsApp Business (Meta).
 * Le visiteur du site n'a pas de numéro : Meta ne peut lui envoyer rien. En revanche chaque échange (message du visiteur + réponse de
 * l'assistant) est copié par WhatsApp vers WHATSAPP_WEB_MIRROR_NUMBER, pour que l'équipe suive le chat du site depuis WhatsApp.
 *
 * Fenêtre de 24 h : un texte libre n'est accepté que si ce numéro a écrit au numéro HARX dans les 24 h (code Meta 131047 sinon).
 * Si WHATSAPP_WEB_MIRROR_TEMPLATE est défini, un modèle approuvé prend alors le relais (corps à UN paramètre {{1}}).
 * Au mieux : un échec est journalisé (au plus une fois par 10 min) et n'affecte jamais la réponse au visiteur.
 */
const REENGAGEMENT = 131047;
const hourMs = 3600 * 1000;

export function createWebMirror({ whatsapp, cfg, logger = console, now = () => Date.now() }) {
  if (!cfg.webMirrorNumber) return null;
  const sentAt = [];
  let lastWarn = 0;
  const warn = (msg) => {
    if (now() - lastWarn < 10 * 60 * 1000) return;
    lastWarn = now();
    logger.warn?.(msg);
  };

  return async function mirror({ sessionId, visitorText, reply }) {
    // Plafond horaire
    while (sentAt.length && now() - sentAt[0] > hourMs) sentAt.shift();
    if (sentAt.length >= cfg.webMirrorMaxPerHour) { warn(`[whatsapp-web-mirror] plafond de ${cfg.webMirrorMaxPerHour} copies par heure atteint : copie ignorée`); return false; }
    sentAt.push(now());

    const tag = String(sessionId || '').slice(-6);
    const parts = [`*Chat du site* · visiteur ${tag}`, `Visiteur : ${String(visitorText || '').slice(0, 1500)}`];
    if (reply) parts.push(`Assistant : ${String(reply).slice(0, 2000)}`);
    const text = parts.join('\n\n');
    try {
      await whatsapp.sendText(cfg.webMirrorNumber, text);
      return true;
    } catch (e) {
      if (e instanceof WhatsAppSendError && e.code === REENGAGEMENT && cfg.webMirrorTemplate && whatsapp.sendTemplate) {
        try {
          await whatsapp.sendTemplate(cfg.webMirrorNumber, { name: cfg.webMirrorTemplate, lang: cfg.webMirrorTemplateLang, params: [text] });
          return true;
        } catch (e2) {
          warn(`[whatsapp-web-mirror] modèle refusé par Meta : ${e2.message}`);
          return false;
        }
      }
      warn(e instanceof WhatsAppSendError && e.code === REENGAGEMENT
        ? '[whatsapp-web-mirror] fenêtre de 24 h fermée pour le numéro de l\'équipe : écrivez-lui au numéro HARX, ou définissez WHATSAPP_WEB_MIRROR_TEMPLATE'
        : `[whatsapp-web-mirror] envoi échoué : ${e.message}`);
      return false;
    }
  };
}
