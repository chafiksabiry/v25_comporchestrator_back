# Agent de support SalesIQ (temps réel)

Répond aux visiteurs du chat harx.ai (Zoho SalesIQ) en quelques secondes, à la place du cycle manuel toutes les 10 minutes.

```
Visiteur ─► Zobot SalesIQ ──webhook──► POST /api/salesiq/webhook?key=…
                                         │  réponse HTTP < 4 s (SalesIQ coupe à 5 s)
            salutation ─────────────────►│  {"action":"reply"}   réponse fixe, sans Claude
            autre message ──────────────►│  {"action":"pending"} puis Claude + CRM en arrière-plan
                                         ▼
              POST …/api/v2/{screenname}/callbacks/{request_id}/response  (reply ou forward)
              + note interne sur la conversation (résumé, étape CRM, « A TRAITER PAR UN HUMAIN »)
```

## Modes (`SALESIQ_MODE`)
| Mode | Effet |
|---|---|
| `off` (défaut) | le webhook transfère tout aux opérateurs (`forward`). |
| `shadow` | transfère aux opérateurs et ajoute en note interne un « BROUILLON CLAUDE : … ». Rien n'est envoyé au visiteur. |
| `live` | le bot répond ; transfère à un humain dans les cas prévus. |

## Garanties
- Sources uniques : `src/salesiq/knowledge/pipeline.md` et `faq.md` (modifier ces fichiers suffit). Une réponse contenant `[À COMPLÉTER]` / `[À VÉRIFIER]` n'est jamais envoyée : transfert à un humain.
- Garde-fous en code (`guards.js`) sur toute réponse : pas de nom interne d'étape, de pourcentage, de montant, de lien externe, pas de réponse vide ou trop longue.
- CRM en **lecture seule** (une seule requête GET de recherche de deals) ; aucun outil de suppression, de blocage, d'export ou de clôture.
- Tout échec (Claude, CRM, rappel SalesIQ, erreur de code) aboutit à `forward` ou à une note « A TRAITER PAR UN HUMAIN » : aucun visiteur sans réponse.
- Le texte des messages n'est pas journalisé (`SALESIQ_LOG_MESSAGE_TEXT=1` pour l'activer).

## Variables d'environnement (Railway)
| Variable | Rôle |
|---|---|
| `SALESIQ_MODE` | `off` / `shadow` / `live` |
| `SALESIQ_WEBHOOK_KEY` | secret ajouté à l'URL du webhook (`?key=`) |
| `SALESIQ_WEBHOOK_PUBLIC_KEY` | (optionnel) clé publique RSA « Secure your webhook » ; si définie, `x-siqsignature` doit être valide en plus |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` | client OAuth « Self Client » |
| `ZOHO_ACCOUNTS_URL`, `ZOHO_SALESIQ_API_URL`, `ZOHO_CRM_API_URL` | selon le centre de données (défaut : `.com`) |
| `ANTHROPIC_API_KEY` | déjà présente sur le service |
| `SALESIQ_CLAUDE_MODEL` (défaut `claude-sonnet-5-5`), `SALESIQ_CLAUDE_EFFORT` | modèle et effort |
| `SALESIQ_SCREENNAME` (`harxtechnologiesinc`), `SALESIQ_OPERATOR_ID`, `ZOHO_CRM_PIPELINE` (`Reps Pipeline`) | paramètres HARX |
| `SALESIQ_LOG_PAYLOAD_SHAPE` | journalise la structure (jamais les valeurs) des webhooks, pour le premier branchement |

Scopes OAuth du Self Client : `SalesIQ.callbacks.UPDATE,SalesIQ.conversations.READ,SalesIQ.conversations.CREATE,SalesIQ.conversations.UPDATE,ZohoCRM.modules.deals.READ`.

## Tests
`npm run salesiq:test` (aucun appel réseau : Claude et Zoho sont simulés).
