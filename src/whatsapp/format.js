/** Adapte le texte de Claude au balisage WhatsApp (*gras*, _italique_) et retire ce qui s'y affiche mal. */
export function toWhatsAppFormat(text) {
  let t = String(text ?? '').replace(/\r\n/g, '\n');
  t = t.replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1'); // blocs de code
  t = t.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '*$1*'); // titres -> gras
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '*$1*'); // **gras** -> *gras*
  t = t.replace(/__([^_\n]+)__/g, '_$1_');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1: $2'); // liens Markdown
  t = t.replace(/^\s*\|?[-:\s|]{5,}\|?\s*$/gm, ''); // séparateurs de tableau
  t = t.replace(/^\s*[*•]\s+/gm, '- '); // puces
  t = t.replace(/<\/?(?:thinking|analysis|reasoning)>/gi, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
