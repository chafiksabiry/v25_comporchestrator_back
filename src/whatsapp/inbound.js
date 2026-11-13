/**
 * Extrait les événements utiles d'un corps de webhook WhatsApp Cloud API.
 * Format : { object: 'whatsapp_business_account', entry: [{ id, changes: [{ field: 'messages', value: { metadata, contacts, messages, statuses } }] }] }
 */
export function parseWebhookPayload(body, { expectedPhoneNumberId = '' } = {}) {
  const messages = [];
  const statuses = [];
  if (!body || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return { messages, statuses };

  for (const entry of body.entry) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || '';
      // Ignore les événements d'un autre numéro de l'application (le même webhook peut en servir plusieurs).
      if (expectedPhoneNumberId && phoneNumberId && phoneNumberId !== expectedPhoneNumberId) continue;
      // Nom du contact, retrouvé par numéro (wa_id) ou, à défaut, par identifiant BSUID (user_id).
      const names = new Map();
      for (const c of value.contacts || []) {
        const name = c.profile?.name || '';
        if (c.wa_id) names.set(String(c.wa_id), name);
        if (c.user_id) names.set(String(c.user_id), name);
      }

      for (const m of value.messages || []) {
        // Depuis le déploiement des noms d'utilisateur WhatsApp, `from` (numéro) peut manquer : l'expéditeur est alors
        // identifié par `from_user_id` (BSUID, ex. « US.13491208655302741918 »).
        const sender = String(m?.from || m?.from_user_id || '');
        if (!m?.id || !sender) continue;
        let text = '';
        let kind = m.type || 'unknown';
        if (m.type === 'text') text = m.text?.body || '';
        else if (m.type === 'button') text = m.button?.text || m.button?.payload || '';
        else if (m.type === 'interactive') {
          text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '';
        } else if (m.type === 'image' || m.type === 'video' || m.type === 'document') {
          text = m[m.type]?.caption || '';
        }
        messages.push({
          id: m.id,
          from: sender,
          name: names.get(sender) || '',
          timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date(),
          type: kind,
          text: String(text || '').trim(),
          supported: ['text', 'button', 'interactive'].includes(m.type) || (['image', 'video', 'document'].includes(m.type) && Boolean(text)),
          phoneNumberId,
        });
      }
      for (const s of value.statuses || []) {
        statuses.push({ id: s.id, status: s.status, recipient: s.recipient_id, errors: s.errors || [] });
      }
    }
  }
  return { messages, statuses };
}
