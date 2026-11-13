/**
 * Détection de langue déterministe, appelée à CHAQUE message entrant.
 *
 * Rôle dans l'architecture : Claude reste le seul auteur des réponses et le juge final de la langue ; ce détecteur
 *  1. fournit à Claude un indice (language_hint) fiable, y compris pour la Darija (arabe ou latin « arabizi ») et les
 *     messages mélangeant français et Darija, que les détecteurs génériques classent mal ;
 *  2. sert de contrôle APRÈS génération : si la réponse de Claude est clairement dans une autre langue que le message
 *     de l'utilisateur, la réponse est régénérée avec une consigne de correction (voir agent.js).
 *
 * Codes : fr en es de it pt ar (arabe standard) ary (Darija marocaine) unknown.
 */

const STOP = {
  fr: 'le la les un une des du de et est sont je tu il elle nous vous ils pour pas que qui dans sur avec ce cette ces mon ma mes ton ta votre vos notre comment pourquoi où quand bonjour bonsoir salut merci svp plaît plait peux peut puis veux voudrais besoin compte mot passe ai suis ne ça cest jai nai pouvez comment quel quelle aide problème probleme erreur ou mais donc alors aussi très tres fait faire être etre avoir'.split(' '),
  en: 'the a an and is are was were i you he she we they for not that this these those with my your our how why where when hello hi hey thanks thank please can could would should want need account password what do does did have has to of in on it its me am be been help problem error issue but so also very just get make'.split(' '),
  es: 'el la los las un una unos unas y es son soy yo tú tu usted nosotros ustedes para no que con mi mis su sus cómo como por qué porque dónde donde cuándo cuando hola gracias favor puedo puede quiero necesito cuenta contraseña ayuda problema error pero también muy estoy está esta'.split(' '),
  de: 'der die das und ist sind ich du er sie wir ihr für nicht mit mein meine dein ihr wie warum wo wann hallo danke bitte kann können möchte brauche konto passwort hilfe problem fehler aber auch sehr habe haben'.split(' '),
  it: 'il lo la gli le un una e è sono io tu lui lei noi voi per non che con mio mia tuo come perché dove quando ciao grazie favore posso può voglio ho bisogno account password aiuto problema errore ma anche molto sto'.split(' '),
  pt: 'o os as um uma e é são eu você ele ela nós vocês para não que com meu minha seu como por porque onde quando olá ola obrigado obrigada favor posso pode quero preciso conta senha ajuda problema erro mas também muito estou'.split(' '),
};
// Mots à un seul sens de langue (poids double) : évitent qu'un « la », « de » ou « a » commun décide seul.
const SHARED_WEAK = new Set(['a', 'la', 'le', 'de', 'un', 'una', 'no', 'me', 'es', 'e', 'o', 'lo', 'el', 'en', 'as', 'se', 'te', 'les', 'or', 'si', 'ce', 'ma', 'ta', 'mi', 'su', 'in', 'is', 'am']);

const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)]));

const ACCENT_HINT = { fr: /[éèêàçùôîâ]/g, es: /[ñ¿¡áíóú]/g, de: /[ßäöü]/g, pt: /[ãõ]/g, it: /[ìò]/g };

/** Darija écrite en caractères latins (« arabizi ») : mots courants, orthographe libre. */
const DARIJA_LATIN = new Set(
  ('salam slm salamo kifach kifash kifah kif bghit bghina bgha bghiti bghitu bghat wach wash wesh chno chnou shno shnou achno chnouwa ' +
    'dyal diyal dial dyali diali dyalek dyalk dyalna mzyan mezyan mzyana 3afak afak 3fak daba dba dabe bzaf bzzaf bezaf fin fine 3lach 3lash alach ' +
    'machi makayn makaynch kayn kayna kayn ghadi ghad ghadir rah raha rani rana rak hna hnaya walo khouya khoya khoyia sahbi sa7bi safi wakha wa9ila ' +
    'mouchkil mochkil moshkil mouchkila mochkila machakil sir siri chouf chof lyoum lyom ghda mnin mn 3ndi 3ndk 3ndna 3ndo ndna ' +
    'ana nta nti howa hiya ntouma kat9dar kayt3 ma9drach mat9drch ma9dertch mabghitch mabghitsh mafhemtch mafhemtsh ndir ndiro dir diri kidir ' +
    'labas lbas hamdullah hamdulillah hamdollah inchallah insha bslama choukran shukran choukrane merhba mrhba mrehba tfaddal ' +
    'chwiya chwia bzzaf kolchi kolshi kolxi walakin walaken lakin hit 7it hta 7ta 9bel mazal mazalni mazelt ba3d 3tini 3tani sift sifti ' +
    'zwin zwina khdma khdem khedma 7sab 7ssab compte2 flous flouss drahem tele ghir ghayr gha b3da 3awd 3awtani t9dar t9der fhemt fhamt fhemtini 7ta ' +
    'wlla wla dakchi dak had hadi hada hadchi hadshi lli li daba nit nichan ida3 ydir kidayr kidayra kayna lah allah ' +
    'chi bach bash m3a 3la mli fhad fhadi kaykhdem khdam kifach3 3ndkom lbarah lbare7 ghda sbah salam3alikoum').split(/\s+/),
);
/** Salutations/remerciements partagés avec d'autres langues : seuls, ils ne suffisent pas à fixer la langue. */
const DARIJA_WEAK = new Set(['salam', 'slm', 'salamo', 'choukran', 'shukran', 'choukrane', 'inchallah', 'insha', 'hamdullah', 'hamdulillah', 'hamdollah', 'allah', 'lah', 'merhba', 'mrhba', 'safi', 'ana', 'ila']);
const DARIJA_DIGIT_WORD = /^(?=.*[a-z]{2,})(?:[a-z]*[379][a-z]+|[a-z]+[379][a-z]*)$/;
const DIGIT_WORD_EXCLUDE = new Set(['mp3', 'mp4', 'b2b', 'h2o', 'g3', 'a4', 'k9', 'x3', 'b3', 'p3', 'i7', 'i9', 'r9', 'ps3', 'cr7', 'f9']);

/** Darija écrite en arabe, après normalisation (voir normalizeArabic). */
const DARIJA_ARABIC = new Set(
  ('كيفاش كيفاش فين علاش واش ديال ديالي ديالك ديالنا ديالهم بغيت بغينا بغيتي بغا باغي باغيه شنو شنوا اش دابا مزيان مزيانه لاباس ماشي ماكاينش كاين كاينه كاينين ' +
    'غادي غادير راه راني راك راها بزاف فاش شحال هاد هادي هادا هادشي هاذ هاذي عفاك عافاك مشكل مشاكل واخا صافي خويا خوي صاحبي ياخي حيت ديرو دير ' +
    'مابغيتش ماقدرتش ماعرفتش مافهمتش ماقدرتش ماوصلتش كنخدم كنقدر كندير كنبغي كيبان كيجي كتبان فهمت فهمتي ليوم غدا دابا لي فين ' +
    'نتا نتي هو هي هوما حنا نتوما شوية شويه واخا زوين ولا خدمه خدمة فلوس دراهم سير شوف تقدر تقدري بلا بغيت').split(/\s+/),
);

export function normalizeArabic(s) {
  return String(s)
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel, tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}
const DARIJA_ARABIC_NORM = new Set([...DARIJA_ARABIC].map(normalizeArabic));

function tokenize(text) {
  const lower = String(text).toLowerCase().normalize('NFC');
  // Les URL, adresses e-mail et identifiants n'ont pas de langue.
  const cleaned = lower.replace(/https?:\/\/\S+|\S+@\S+\.\S+|`[^`]*`/g, ' ');
  return cleaned.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) || [];
}

const stripApos = (t) => t.replace(/['’]/g, '');

/**
 * @param {string} text message de l'utilisateur
 * @returns {{language: string, script: 'latin'|'arabic'|'other'|'none', style: string, mixedWith: string|null,
 *            confidence: 'high'|'medium'|'low', scores: object}}
 */
export function detectLanguage(text) {
  const raw = String(text ?? '');
  const letters = raw.match(/\p{L}/gu) || [];
  const empty = { language: 'unknown', script: 'none', style: 'unknown', mixedWith: null, confidence: 'low', scores: {} };
  if (letters.length === 0) return empty;

  const arabicLetters = (raw.match(/\p{Script=Arabic}/gu) || []).length;
  const latinLetters = (raw.match(/\p{Script=Latin}/gu) || []).length;
  const tokens = tokenize(raw);

  // ---------- Écriture arabe ----------
  if (arabicLetters >= Math.max(2, letters.length * 0.3)) {
    const arTokens = tokens.filter((t) => /\p{Script=Arabic}/u.test(t)).map(normalizeArabic);
    const darijaHits = arTokens.filter((t) => DARIJA_ARABIC_NORM.has(t)).length;
    const isDarija = darijaHits >= 2 || (darijaHits >= 1 && darijaHits / Math.max(arTokens.length, 1) >= 0.15);
    const latinTokens = tokens.filter((t) => /^[a-z]+$/.test(t));
    const mixed = latinTokens.length >= 2 && latinLetters >= arabicLetters * 0.25;
    return {
      language: isDarija ? 'ary' : 'ar',
      script: 'arabic',
      style: isDarija ? 'darija_arabic' : 'arabic_standard',
      mixedWith: mixed ? 'latin' : null,
      confidence: arTokens.length >= 2 ? 'high' : 'medium',
      scores: { darijaHits, arabicTokens: arTokens.length },
    };
  }

  // ---------- Écriture latine ----------
  const scores = { fr: 0, en: 0, es: 0, de: 0, it: 0, pt: 0 };
  let darija = 0;
  let darijaStrongHits = 0;
  for (const rawTok of tokens) {
    const tok = stripApos(rawTok);
    for (const [lang, set] of Object.entries(STOP_SETS)) {
      if (set.has(tok) || set.has(rawTok)) scores[lang] += SHARED_WEAK.has(tok) ? 0.5 : 1;
    }
    if (DARIJA_LATIN.has(tok)) { darija += 1; if (!DARIJA_WEAK.has(tok)) darijaStrongHits += 1; }
    else if (DARIJA_DIGIT_WORD.test(tok) && !DIGIT_WORD_EXCLUDE.has(tok) && /^[a-z0-9]+$/.test(tok)) { darija += 1; darijaStrongHits += 1; }
  }
  for (const [lang, re] of Object.entries(ACCENT_HINT)) {
    const hits = (raw.toLowerCase().match(re) || []).length;
    if (hits) scores[lang] += Math.min(hits, 3) * 0.5;
  }
  // « j'ai », « c'est », « qu'est » : contractions françaises ; « I'm », « don't » : anglaises.
  scores.fr += (raw.toLowerCase().match(/\b(?:j|c|qu|l|d|n|s|m|t)['’][a-zàâéèêëîïôùûç]/g) || []).length * 0.7;
  scores.en += (raw.toLowerCase().match(/\b\w+['’](?:m|re|ve|ll|s|t|d)\b/g) || []).length * 0.7;

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topLang, topScore] = ranked[0];
  const secondScore = ranked[1][1];
  const wordCount = tokens.length;
  const darijaShare = darija / Math.max(wordCount, 1);

  const result = (language, style, mixedWith, confidence) => ({
    language, script: 'latin', style, mixedWith, confidence, scores: { ...scores, darija },
  });

  // Darija latine : au moins 2 indices, ou 1 indice sur un message très court.
  // Un mot isolé comme « salam » ou « choukran » est ambigu : on garde alors la langue de la conversation.
  if (darija >= 1 && darijaStrongHits === 0 && wordCount <= 2) return result('unknown', 'unknown', null, 'low');
  const darijaStrong = darija >= 2 || (darija >= 1 && wordCount <= 3);
  if (darijaStrong && darijaShare >= 0.2) {
    // Mélange français/anglais + Darija : tout de même dans « le style de l'utilisateur » -> code ary, drapeau mixedWith.
    const mix = topScore >= 2 && topScore >= darija * 0.8 ? topLang : null;
    return result('ary', mix ? 'mixed_darija_' + mix : 'darija_latin', mix, 'high');
  }
  if (darijaStrong && topScore >= 2) {
    return result(topLang, 'mixed_' + topLang + '_darija', 'ary', 'medium');
  }

  if (topScore < 1.5 || (topScore - secondScore < 0.5 && topScore < 3)) {
    // Trop peu d'indices : « ok », « merci », « 12345 »…
    const weakLang = topScore >= 1 ? topLang : 'unknown';
    return result(weakLang, 'unknown', null, 'low');
  }
  const confidence = topScore >= 3 && topScore - secondScore >= 1.5 ? 'high' : 'medium';
  return result(topLang, 'standard', null, confidence);
}

/**
 * Langue « effective » à transmettre à Claude comme indice : si le message est trop court pour être fiable
 * (« ok », « 👍 », un numéro), on garde la langue de la conversation ; sinon la langue du message l'emporte
 * (l'utilisateur peut changer de langue à tout moment).
 */
export function resolveLanguage(detection, previous = null) {
  if (detection.confidence !== 'low' && detection.language !== 'unknown') {
    return { ...detection, source: 'message' };
  }
  if (previous && previous.language && previous.language !== 'unknown') {
    return { ...previous, source: 'conversation' };
  }
  return { ...detection, source: 'message' };
}

const LATIN_ONLY_FOREIGN = ['fr', 'en', 'es', 'de', 'it', 'pt'];

/**
 * Contrôle post-génération : la réponse est-elle dans la bonne langue ?
 * Volontairement tolérant : on ne rejette que les écarts nets (réponse longue clairement dans une autre langue).
 * @returns {{ok: boolean, reason: string|null, reply: object}}
 */
export function checkReplyLanguage(userDetection, replyText) {
  const reply = detectLanguage(replyText);
  const ok = (reason = null) => ({ ok: true, reason, reply });
  const bad = (reason) => ({ ok: false, reason, reply });

  if (!userDetection || userDetection.confidence === 'low' || userDetection.language === 'unknown') return ok('user_language_uncertain');
  const replyLetters = (String(replyText).match(/\p{L}/gu) || []).length;
  if (replyLetters < 12) return ok('reply_too_short');

  const u = userDetection;
  // Mot mêlant lettres latines et arabes (ex. « daخlin ») : défaut de génération, à régénérer.
  if (/[A-Za-z]+[\u0600-\u06FF]|[\u0600-\u06FF]+[A-Za-z]/.test(String(replyText))) return bad('mixed_scripts_inside_a_word');
  // Une réponse en arabe/Darija contient souvent beaucoup de termes produit latins (GIG, Dashboard, Reserved Slots...) :
  // elle est « en écriture arabe » dès qu'elle contient plusieurs mots arabes en proportion notable.
  const arWords = (String(replyText).match(/\p{Script=Arabic}+/gu) || []).length;
  const arLetters = (String(replyText).match(/\p{Script=Arabic}/gu) || []).length;
  const replyArabic = reply.script === 'arabic' || (arWords >= 3 && arLetters / replyLetters >= 0.2);

  if (u.script === 'arabic') {
    // Arabe / Darija en écriture arabe -> réponse en écriture arabe.
    return replyArabic ? ok() : bad('user_wrote_arabic_script_reply_is_not');
  }
  if (u.language === 'ary') {
    // Darija latine (éventuellement mêlée de français) : une réponse en pur français/anglais standard est un écart.
    if (replyArabic) return ok('reply_in_arabic_script');
    if (reply.language === 'ary') return ok();
    if (reply.confidence === 'high' && LATIN_ONLY_FOREIGN.includes(reply.language) && reply.style === 'standard') {
      return bad('user_wrote_darija_reply_is_standard_' + reply.language);
    }
    return ok();
  }
  if (LATIN_ONLY_FOREIGN.includes(u.language)) {
    if (reply.language === u.language) return ok();
    if (reply.mixedWith === u.language) return ok();
    if (reply.confidence === 'low') return ok('reply_language_uncertain');
    if (replyArabic) return bad('reply_in_arabic_script_user_wrote_' + u.language);
    return bad(`user_wrote_${u.language}_reply_is_${reply.language}`);
  }
  if (u.language === 'ar') return replyArabic ? ok() : bad('user_wrote_arabic_reply_is_not');
  return ok();
}

/** Nom lisible de la langue/du style, pour l'indice donné à Claude. */
export const LANGUAGE_LABELS = {
  fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
  ar: 'Modern Standard Arabic', ary: 'Moroccan Arabic (Darija)', unknown: 'unknown',
};
