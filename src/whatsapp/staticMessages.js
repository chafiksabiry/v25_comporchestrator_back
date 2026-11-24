/**
 * Messages fixes (sans appel à Claude) pour les rares cas où Claude ne peut pas répondre : limite de débit, panne.
 * La langue vient de la détection ; langue inconnue -> anglais + français.
 */
const M = {
  fr: { rate: 'Vous envoyez beaucoup de messages en peu de temps. Merci de patienter quelques instants avant de continuer.', down: 'Notre assistant est momentanément indisponible. Votre message est bien reçu : réessayez dans quelques minutes, ou contactez l’équipe support HARX.', refusal: 'Je ne peux pas traiter cette demande. Si vous avez besoin d’aide sur HARX, reformulez votre question ou demandez l’équipe support.' },
  en: { rate: 'You are sending many messages in a short time. Please wait a moment before continuing.', down: 'Our assistant is temporarily unavailable. Your message was received: please try again in a few minutes, or contact the HARX support team.', refusal: 'I can’t help with that request. If you need help with HARX, please rephrase your question or ask for the support team.' },
  es: { rate: 'Estás enviando muchos mensajes en poco tiempo. Espera un momento antes de continuar.', down: 'Nuestro asistente no está disponible temporalmente. Recibimos tu mensaje: inténtalo de nuevo en unos minutos o contacta con el equipo de soporte de HARX.', refusal: 'No puedo ayudar con esa solicitud. Si necesitas ayuda con HARX, reformula tu pregunta o pide hablar con el equipo de soporte.' },
  ar: { rate: 'أنت ترسل رسائل كثيرة في وقت قصير. يرجى الانتظار قليلاً قبل المتابعة.', down: 'المساعد غير متوفر مؤقتاً. وصلتنا رسالتك: يرجى المحاولة بعد بضع دقائق أو التواصل مع فريق دعم HARX.', refusal: 'لا أستطيع المساعدة في هذا الطلب. إذا كنت تحتاج مساعدة بخصوص HARX، أعد صياغة سؤالك أو اطلب فريق الدعم.' },
  ary_ar: { rate: 'كتصيفط بزاف د الميساجات فوقت قصير. تسنى شوية عافاك قبل ما تكمل.', down: 'المساعد ما خدامش دابا. الميساج ديالك وصلنا: عاود جرب من بعد شي دقايق، ولا تواصل مع فريق الدعم ديال HARX.', refusal: 'ما نقدرش نعاونك فهاد الطلب. إلا بغيتي مساعدة فـ HARX، عاود صيغ السؤال ولا طلب فريق الدعم.' },
  ary_lat: { rate: 'Kat-sift bzaf d les messages f waqt qsir. Tsenna chwiya 3afak qbel ma tkemmel.', down: 'L’assistant ma khdamch daba. Message dyalek wsel lina: 3awd jarrab mn ba3d chi d9ayeq, wla tcontacti l’équipe support dyal HARX.', refusal: 'Ma n9drch n3awnek f had talab. Ila bghiti mosa3ada f HARX, 3awd sigh soual dyalek wla tlob l’équipe support.' },
  de: { rate: 'Sie senden viele Nachrichten in kurzer Zeit. Bitte warten Sie einen Moment.', down: 'Unser Assistent ist vorübergehend nicht verfügbar. Ihre Nachricht ist angekommen: bitte versuchen Sie es in einigen Minuten erneut oder kontaktieren Sie das HARX-Support-Team.', refusal: 'Dabei kann ich nicht helfen. Wenn Sie Hilfe zu HARX brauchen, formulieren Sie Ihre Frage bitte um oder fragen Sie nach dem Support-Team.' },
  it: { rate: 'Stai inviando molti messaggi in poco tempo. Attendi un momento prima di continuare.', down: 'Il nostro assistente non è temporaneamente disponibile. Abbiamo ricevuto il tuo messaggio: riprova tra qualche minuto o contatta il team di supporto HARX.', refusal: 'Non posso aiutarti con questa richiesta. Se ti serve aiuto con HARX, riformula la domanda o chiedi il team di supporto.' },
  pt: { rate: 'Você está enviando muitas mensagens em pouco tempo. Aguarde um momento antes de continuar.', down: 'Nosso assistente está temporariamente indisponível. Recebemos sua mensagem: tente novamente em alguns minutos ou fale com a equipe de suporte da HARX.', refusal: 'Não posso ajudar com esse pedido. Se precisar de ajuda com a HARX, reformule a pergunta ou peça a equipe de suporte.' },
};

export function staticMessage(kind, language) {
  const code = language?.language;
  if (code === 'ary') return M[language.script === 'arabic' ? 'ary_ar' : 'ary_lat'][kind];
  if (M[code]) return M[code][kind];
  return `${M.en[kind]}\n\n${M.fr[kind]}`;
}
