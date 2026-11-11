/**
 * États d'un appel de test Twilio. Qui a décroché est prouvé par la touche 1 (DTMF) : un répondeur ne l'appuie pas.
 * La détection de répondeur (AMD) n'est qu'un indice : une personne qui décroche avec une longue formule d'accueil
 * est parfois classée « machine_start », et l'appel ne doit jamais être coupé sur ce seul indice.
 */
export const isTwilioMachineAnswer = (answeredBy) => {
  const v = String(answeredBy || '').toLowerCase();
  return Boolean(v) && v !== 'human' && v !== 'unknown';
};

/** Un répondeur laisse le message se dérouler en entier (annonce, invite, délai de confirmation) : en deçà, c'est une personne qui a raccroché. */
export const VOICEMAIL_MIN_SECONDS = 20;

export const mapTwilioCallStatus = (raw, { answeredBy, humanConfirmed, prev, duration } = {}) => {
  const s = String(raw || '').toLowerCase();
  const machine = isTwilioMachineAnswer(answeredBy || prev?.answeredBy);
  const confirmed = Boolean(humanConfirmed || prev?.humanConfirmed);

  if (s === 'queued' || s === 'accepted') {
    return { status: 'connecting', outcome: null };
  }
  if (s === 'ringing' || s === 'initiated') {
    return { status: 'ringing', outcome: null, reachedRinging: true };
  }
  if (s === 'in-progress') {
    // Décroché au sens de l'opérateur : on attend la touche 1, même si la détection soupçonne un répondeur.
    return {
      status: confirmed ? 'active' : 'ringing',
      outcome: null,
      reachedRinging: true,
      reachedActive: confirmed,
      answeredBy: answeredBy || null,
    };
  }
  if (s === 'completed') {
    // La touche 1 prouve qu'une personne a décroché, quoi qu'ait pensé la détection.
    if (confirmed) {
      return { status: 'ended', outcome: 'completed', reachedRinging: true, reachedActive: true };
    }
    const seconds = Number(duration ?? prev?.duration);
    if (machine && (!Number.isFinite(seconds) || seconds >= VOICEMAIL_MIN_SECONDS)) {
      return { status: 'ended', outcome: 'voicemail', reachedRinging: true, reachedActive: false, answeredBy };
    }
    // Raccroché avant d'avoir appuyé sur 1 : l'appel a été pris, mais rien ne prouve que la ligne fonctionne de bout en bout.
    if (Number.isFinite(seconds) && seconds > 0) {
      return { status: 'ended', outcome: 'unconfirmed', reachedRinging: true, reachedActive: false, answeredBy: answeredBy || null };
    }
    // Terminé sans confirmation ni durée : pas un vrai décroché sur le combiné.
    return {
      status: 'ended',
      outcome: prev?.reachedRinging ? 'no-answer' : 'failed',
      reachedRinging: Boolean(prev?.reachedRinging),
      reachedActive: false,
    };
  }
  if (s === 'busy') {
    return { status: 'ended', outcome: 'busy', reachedRinging: true };
  }
  if (s === 'no-answer') {
    return { status: 'ended', outcome: 'no-answer', reachedRinging: true };
  }
  if (s === 'canceled') {
    return { status: 'ended', outcome: 'canceled' };
  }
  if (s === 'failed') {
    return { status: 'ended', outcome: 'failed' };
  }
  return { status: 'connecting', outcome: null };
};
