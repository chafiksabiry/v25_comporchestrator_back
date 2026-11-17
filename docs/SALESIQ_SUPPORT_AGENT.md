# Agent de support SalesIQ (temps réel)

Répond aux visiteurs du chat harx.ai (Zoho SalesIQ) en quelques secondes, à la place du cycle manuel toutes les 10 minutes.

```
Visiteur ─► Zobot SalesIQ ──webhook──► POST /api/salesiq/webhook?key=…
                                         │  réponse HTTP < 4 s (SalesIQ coupe à 5 s)
            salutation ─────────────────►│  {"action":"reply"}   réponse fixe, sans Claude
            autre message ──────────────►│  {"action":"pending"} puis Claude + CRM en arrière-plan
                                         ▼
              POST …/api/v2/{screenname}/callbacks/{request_id}/response  (toujours « reply »)
              + note interne sur la conversation (réponse envoyée, étape CRM ; « A TRAITER PAR UN HUMAIN » si besoin)
```

## Modes (`SALESIQ_MODE`)
Aucun mode ne transfère la conversation à un opérateur : le service n'envoie jamais l'action `forward` (pas de demande Accept/Decline).

| Mode | Effet |
|---|---|
| `off` (défaut) | le visiteur reçoit une réponse de repli honnête (« votre demande a été enregistrée pour l'équipe HARX »), sans Claude. |
| `shadow` | réponse de repli au visiteur ; Claude rédige en plus un « BROUILLON CLAUDE » en note interne (rien d'autre n'est envoyé). |
| `live` | Claude répond seul aux visiteurs, d'après `knowledge/` et le CRM. |

## Garanties
- Sources uniques : `src/salesiq/knowledge/pipeline.md` et `faq.md` (modifier ces fichiers suffit). Une réponse qui dépend d'un passage `[À COMPLÉTER]` / `[À VÉRIFIER]` n'est jamais donnée : Claude appelle `flag_for_team` (réponse honnête au visiteur + note « A TRAITER PAR UN HUMAIN » pour l'équipe, sans transfert ni interruption).
- Dans `pipeline.md` et `faq.md`, « passer à un humain » et « transmettre à un membre de l'équipe » signifient `flag_for_team`.
- Garde-fous en code (`guards.js`) sur toute réponse : pas de nom interne d'étape, de pourcentage, de montant, de lien externe, pas d'annonce de transfert, pas de réponse vide ou trop longue. Une réponse refusée est remplacée par la réponse de repli.
- CRM en **lecture seule** (une seule requête GET de recherche de deals) ; aucun outil de suppression, de blocage, d'export ou de clôture.
- Tout échec (Claude, CRM, rappel SalesIQ, erreur de code) aboutit à la réponse de repli et à une note : aucun visiteur sans réponse.
- Chaque réponse envoyée est consignée en note interne (« RÉPONSE CLAUDE (envoyée) ») pour relecture.
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
