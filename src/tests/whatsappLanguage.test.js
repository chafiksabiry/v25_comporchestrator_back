import assert from 'node:assert/strict';
import { detectLanguage, resolveLanguage, checkReplyLanguage } from '../whatsapp/language.js';

const expectLang = (text, language, extra = {}) => {
  const d = detectLanguage(text);
  assert.equal(d.language, language, `"${text}" -> got ${d.language}/${d.style}/${d.confidence}, expected ${language}`);
  if (extra.script) assert.equal(d.script, extra.script, `"${text}" script`);
  if (extra.style) assert.equal(d.style, extra.style, `"${text}" style ${d.style}`);
  if (extra.notLow) assert.notEqual(d.confidence, 'low', `"${text}" should not be low confidence`);
};

// ---------- Français ----------
for (const t of [
  'Bonjour, je n’arrive pas à créer mon compte entreprise',
  'Comment configurer la téléphonie et acheter un numéro ?',
  "J'ai reçu une erreur quand je veux activer mon gig, pouvez-vous m'aider ?",
  'Quel est le prix du forfait Starter et combien de gigs puis-je activer ?',
  "Je voudrais savoir comment ajouter un membre à mon équipe s'il vous plaît",
  'Mon mot de passe ne fonctionne plus et je ne reçois pas le code de vérification',
  'Pourquoi mon appel est bloqué alors que j’ai réservé un créneau ?',
]) expectLang(t, 'fr', { script: 'latin', notLow: true });

// ---------- Anglais ----------
for (const t of [
  'Hello, how can I upgrade my subscription plan?',
  'How do I create a GIG and activate it?',
  'I cannot log in to my account and I did not receive the verification code',
  'What is the difference between late attendance and early check-out?',
  "I'd like to know why my phone number purchase failed",
  'Can you explain how reserved slots work for REPs?',
]) expectLang(t, 'en', { script: 'latin', notLow: true });

// ---------- Espagnol / allemand / italien / portugais ----------
expectLang('Hola, necesito ayuda con mi cuenta y mi contraseña', 'es');
expectLang('¿Cómo puedo activar mi gig y comprar un número de teléfono?', 'es');
expectLang('Hallo, ich brauche Hilfe mit meinem Konto und dem Passwort', 'de');
expectLang('Ciao, ho bisogno di aiuto con il mio account e la password', 'it');
expectLang('Olá, preciso de ajuda com a minha conta e a senha', 'pt');

// ---------- Arabe standard (écriture arabe) ----------
for (const t of [
  'مرحبا، كيف يمكنني إنشاء حساب جديد على المنصة؟',
  'أرغب في معرفة كيفية تفعيل المهمة الخاصة بي وشراء رقم هاتف',
  'لماذا لا أستطيع تسجيل الدخول إلى حسابي؟',
]) expectLang(t, 'ar', { script: 'arabic', style: 'arabic_standard' });

// ---------- Darija en écriture arabe ----------
for (const t of [
  'واش ممكن تعاونني؟ ما قدرتش نسجل الدخول ديالي',
  'بغيت نعرف كيفاش نشري نمرة ديال التيليفون',
  'شنو هو الفرق بين الباقات؟ بغيت نبدا بالمجان',
  'ماكاينش الكود ديال التحقق فالإيميل ديالي، دابا شنو ندير؟',
  'مشكل فالتطبيق، ما بغاش يفتح الصفحة ديال الدفع',
]) expectLang(t, 'ary', { script: 'arabic', style: 'darija_arabic' });

// ---------- Darija en lettres latines (arabizi) ----------
for (const t of [
  'salam khouya, kifach n9ad nsjjel f HARX? bghit ncreer compte',
  'mochkil f la connexion, ma9dertch ndkhel l compte dyali',
  'kifach nbddel lmot de passe dyali ?',
  'wach kayn chi forfait mzyan l chrika dyali? bghit n3rf ch7al kayswa',
  'safi fhemt, choukran bzaf 3la lmosa3ada',
  'ana bghit n3ref kifach ndir session planning, ma fhemtch',
]) expectLang(t, 'ary', { script: 'latin', notLow: true });

// ---------- Mélange français + Darija ----------
for (const t of [
  'Salut, wach kayn chi forfait Starter? bghit n3rf le prix',
  'salam, j’ai un mochkil avec mon gig, ma9dertch nactivih',
  'bonjour khouya, kifach n’activer mon compte entreprise ? 3afak',
]) {
  const d = detectLanguage(t);
  assert.equal(d.language, 'ary', `"${t}" -> ${d.language}/${d.style}`);
  assert.equal(d.confidence === 'low', false);
}

// ---------- Messages courts / ambigus : confiance faible, la conversation décide ----------
for (const t of ['ok', '👍', '12345', 'Merci', 'GIG', 'https://harx.ai/fr']) {
  assert.equal(detectLanguage(t).confidence, 'low', `"${t}" should be low confidence`);
}

// ---------- URL / e-mail ne déterminent pas la langue ----------
expectLang('Mon email est jean.dupont@exemple.com et mon site https://example.com/en/help, je n’arrive pas à me connecter', 'fr');

// ---------- Changement de langue en cours de conversation : le NOUVEAU message l'emporte ----------
{
  const fr = resolveLanguage(detectLanguage('Bonjour, comment créer un gig ?'), null);
  assert.equal(fr.language, 'fr');
  const en = resolveLanguage(detectLanguage('Actually, can you explain the pricing in English please?'), fr);
  assert.equal(en.language, 'en');
  assert.equal(en.source, 'message');
  const ary = resolveLanguage(detectLanguage('واش ممكن تشرح ليا كيفاش كيخدم التخطيط؟'), en);
  assert.equal(ary.language, 'ary');
  const lat = resolveLanguage(detectLanguage('3afak kifach n9ad nbddel lmot de passe'), ary);
  assert.equal(lat.language, 'ary');
  assert.equal(lat.script, 'latin');
  // message trop court : on garde la langue précédente (pas de retour au français/anglais par défaut)
  const kept = resolveLanguage(detectLanguage('ok'), lat);
  assert.equal(kept.language, 'ary');
  assert.equal(kept.source, 'conversation');
  // sans historique et message ininterprétable : inconnu (jamais « fr » ou « en » imposé)
  const none = resolveLanguage(detectLanguage('👍'), null);
  assert.equal(none.language, 'unknown');
}

// ---------- Contrôle de la réponse ----------
const FR_REPLY = "Pour activer votre gig, il faut d'abord terminer toutes les étapes de configuration : téléphonie, import des contacts, formation des REPs, script d'appel et planning des sessions.";
const EN_REPLY = 'To activate your gig you first need to complete every setup step: telephony, contacts upload, REP onboarding, call script and session planning.';
const AR_REPLY = 'لتفعيل المهمة يجب أولاً إكمال جميع خطوات الإعداد: الهاتف، رفع جهات الاتصال، تدريب الممثلين، نص المكالمة وتخطيط الجلسات.';
const ARY_AR_REPLY = 'باش تفعل الجيڭ ديالك خاصك أولا تكمل جميع المراحل: التيليفون، تحميل الكونتاكت، تكوين الريپ، السكريبت والبلانينڭ.';
const ARY_LAT_REPLY = 'Bach tfa3el l gig dyalek khasek loula tkemmel ga3 lmarahil: telephonie, upload dyal les contacts, formation dyal les REPs, script w planning. Mnin tkemmelhom ghadi tkoun jahez.';
const ES_REPLY = 'Para activar tu gig primero debes completar todos los pasos de configuración: telefonía, carga de contactos, formación de los REPs, guion de llamada y planificación.';

const U = (t) => detectLanguage(t);
// ok
assert.equal(checkReplyLanguage(U('Comment activer mon gig ?'), FR_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('How do I activate my gig? Please explain'), EN_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('كيف يمكنني تفعيل المهمة الخاصة بي؟'), AR_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('كيفاش نفعل الجيڭ ديالي؟ ما فهمتش'), ARY_AR_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('kifach nfa3el l gig dyali? ma fhemtch'), ARY_LAT_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('Hola, ¿cómo puedo activar mi gig? Necesito ayuda'), ES_REPLY).ok, true);
// écarts : une réponse dans la mauvaise langue doit être détectée
assert.equal(checkReplyLanguage(U('Comment activer mon gig ? Je ne comprends pas'), EN_REPLY).ok, false, 'French user, English reply');
assert.equal(checkReplyLanguage(U('How do I activate my gig? Please explain'), FR_REPLY).ok, false, 'English user, French reply');
assert.equal(checkReplyLanguage(U('كيف يمكنني تفعيل المهمة الخاصة بي؟'), FR_REPLY).ok, false, 'Arabic user, French reply');
assert.equal(checkReplyLanguage(U('كيفاش نفعل الجيڭ ديالي؟ ما فهمتش'), EN_REPLY).ok, false, 'Darija (arabic) user, English reply');
assert.equal(checkReplyLanguage(U('kifach nfa3el l gig dyali? ma fhemtch'), FR_REPLY).ok, false, 'Darija (latin) user, standard French reply');
assert.equal(checkReplyLanguage(U('kifach nfa3el l gig dyali? ma fhemtch'), EN_REPLY).ok, false, 'Darija (latin) user, English reply');
assert.equal(checkReplyLanguage(U('Hola, ¿cómo puedo activar mi gig? Necesito ayuda'), FR_REPLY).ok, false, 'Spanish user, French reply');
// pas de faux positif quand l'utilisateur est incertain ou la réponse très courte
assert.equal(checkReplyLanguage(U('ok'), EN_REPLY).ok, true);
assert.equal(checkReplyLanguage(U('Comment activer mon gig ?'), 'Oui !').ok, true);
// une réponse française contenant des termes produit anglais reste française
assert.equal(checkReplyLanguage(U('Comment activer mon gig ? Je ne comprends pas'), "Ouvrez le Dashboard, cliquez sur Gig Activation puis sur Activate : votre gig passe au statut active et les REPs peuvent alors réserver des slots.").ok, true);

console.log('whatsappLanguage OK');

// ---------- Mots isolés ambigus : la langue de la conversation est conservée ----------
{
  const prev = resolveLanguage(detectLanguage('Bonjour, comment créer un gig ?'), null);
  for (const t of ['salam', 'choukran', 'merci']) {
    const r = resolveLanguage(detectLanguage(t), prev);
    assert.equal(r.language, 'fr', `"${t}" must keep the conversation language`);
  }
  expectLang('kayn chi forfait gratuit ?', 'ary');
  // En revanche, un mot sans ambiguïté change la langue : « bghit » est de la Darija.
  assert.equal(resolveLanguage(detectLanguage('bghit n3ref'), prev).language, 'ary');
}
console.log('whatsappLanguage (ambiguous words) OK');

// ---------- Alphabets mêlés dans un même mot : régénération ----------
{
  const user = detectLanguage('salam, bghit n3rf wach kayn chi forfait Starter w ch7al kayswa le prix');
  const bad = checkReplyLanguage(user, 'Salam! Kayn forfait STARTER f catalogue, les tokens daخlin f had l forfait ma mnchourinch daba, donc ma n9derch nأكد lik.');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'mixed_scripts_inside_a_word');
  assert.equal(checkReplyLanguage(user, 'Salam! Kayn forfait STARTER f catalogue, w les tokens ma mnchourinch daba, donc ma n9derch nconfirmi lik chi r9m.').ok, true);
  // Arabe avec termes produit latins séparés par des espaces : toujours valide
  assert.equal(checkReplyLanguage(detectLanguage('واش ممكن تشرح ليا كيفاش نفعل الجيڭ ديالي؟'), 'خاصك تكمل الخطوات ديال Telephony و Upload contacts و Call script قبل ما تفعل GIG.').ok, true);
}
console.log('whatsappLanguage (mixed scripts) OK');
