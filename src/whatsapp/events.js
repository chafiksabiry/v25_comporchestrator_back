import { EventEmitter } from 'node:events';

/**
 * Évènements « la boîte de réception a changé » (temps réel de l'Inbox support).
 * Un évènement ne porte JAMAIS de contenu de message : seulement l'identifiant de conversation et le motif ; l'Inbox relit les
 * données par les routes HTTP authentifiées /api/whatsapp/admin/*.
 */
export function createInboxBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return bus;
}


/**
 * Enveloppe un store : après chaque écriture utile à l'Inbox, émet { waId, reason } sur le bus. Les erreurs de diffusion n'affectent jamais
 * l'écriture. Motifs : message (nouveau message), handoff (transfert à un humain), ticket (création / mise à jour), deleted (suppression).
 */
export function withInboxEvents(store, bus) {
  const emit = (waId, reason) => {
    if (!waId) return;
    try { bus.emit('change', { waId: String(waId), reason }); } catch { /* diffusion best-effort */ }
  };
  const hooks = {
    appendMessage: (args) => [args[0], 'message'],
    deleteConversation: (args, out) => (out ? [args[0], 'deleted'] : null),
    updateConversation: (args) => (args[1] && 'handoff' in args[1] ? [args[0], 'handoff'] : null),
    createTicket: (args, out) => [out?.waId ?? args[0]?.waId, 'ticket'],
    updateTicket: (_args, out) => [out?.waId, 'ticket'],
  };
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const hook = hooks[prop];
      if (!hook) return value.bind(target);
      return async (...args) => {
        const out = await value.apply(target, args);
        const found = hook(args, out);
        if (found) emit(found[0], found[1]);
        return out;
      };
    },
  });
}

