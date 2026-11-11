/**
 * Test d'appel ENTRANT d'une ligne : le centre appelle sa ligne depuis un téléphone, la ligne répond et le serveur
 * constate la réception. Suivi en mémoire (une session par ligne, durée limitée), le résultat est conservé sur la
 * ligne (`metadata.inboundTest`) par l'appelant.
 */
export const INBOUND_TEST_TTL_MS = 15 * 60 * 1000;

const sessions = new Map();

export function startInboundTest(e164, now = Date.now()) {
  const session = { phoneNumber: e164, status: 'waiting', startedAt: now, expiresAt: now + INBOUND_TEST_TTL_MS, receivedAt: null, from: null, callSid: null };
  sessions.set(e164, session);
  return { ...session };
}

/** Appel reçu sur la ligne : validé seulement si un test est en attente et non expiré. */
export function receiveInboundCall(e164, { from, callSid } = {}, now = Date.now()) {
  const s = sessions.get(e164);
  if (!s || s.status !== 'waiting' || now > s.expiresAt) return null;
  s.status = 'received';
  s.receivedAt = now;
  s.from = from || null;
  s.callSid = callSid || null;
  return { ...s };
}

export function getInboundTest(e164, now = Date.now()) {
  const s = sessions.get(e164);
  if (!s) return null;
  if (s.status === 'waiting' && now > s.expiresAt) return { ...s, status: 'expired' };
  return { ...s };
}

export function clearInboundTests() {
  sessions.clear();
}

/**
 * Un appel réel qui atteint le serveur sur une ligne jamais testée prouve que la ligne est bien reliée : il compte comme test d'appel
 * entrant (la personne qui appelle sa ligne sans avoir lancé le test n'a pas à recommencer). Une ligne déjà testée garde son résultat.
 */
export const needsInboundTestProof = (line) => Boolean(line) && !line.metadata?.inboundTest;

/** Résultat enregistré sur la ligne pour un appel réel : même forme que le test, avec l'origine. */
export const realCallProof = ({ from, callSid } = {}, now = Date.now()) => ({ testedAt: new Date(now).toISOString(), from: String(from || ''), callSid: String(callSid || ''), viaRealCall: true });
