import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge');

/** Charge pipeline.md et faq.md : les SEULES sources sur HARX de l'agent. Modifier ces fichiers suffit, sans toucher au code. */
export function loadKnowledge(dir = DIR) {
  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  return { pipeline: read('pipeline.md'), faq: read('faq.md') };
}
