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
      const names = new Map((value.contacts || []).map((c) => [String(c.wa_id), c.profile?.name || '']));

      for (const m of value.messages || []) {
        if (!m?.id || !m?.from) continue;
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
          from: String(m.from),
          name: names.get(String(m.from)) || '',
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
