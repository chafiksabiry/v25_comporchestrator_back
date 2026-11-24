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

## Recherche dans la base de connaissances HARX
En plus de `pipeline.md`, `faq.md` et du CRM, Claude dispose de deux outils, `search_knowledge` et `read_knowledge_topic`, pour **chercher avant d'abandonner**. Ils interrogent la base de connaissances de l'assistant WhatsApp (`src/whatsapp/kb`), rédigée à partir du code réel des dépôts HARX (recherche en mémoire, quelques millisecondes, aucun service externe).
- Seules les rubriques destinées aux visiteurs sont accessibles : `reps-matching`, `account-signup-login`, `platform-overview` et les textes d'écran de l'application rep. Routes d'API, messages d'erreur du back-office, facturation, rôles, téléphonie et dépannage restent hors de portée (variable `SALESIQ_KB_TOPICS` pour modifier la liste).
- Les chemins de fichiers sources ne sont jamais transmis à Claude ; un garde-fou bloque toute réponse qui contient un nom de dépôt, un chemin, une route ou « base de connaissances ».
- `pipeline.md`, `faq.md` et le CRM passent avant la base en cas de contradiction.
- La base décrit le fonctionnement du produit, pas les décisions métier (qui sélectionne, sous quel délai) : pour cela, `knowledge/` reste la source.
- Pour mettre à jour la base après une évolution du code : `npm run whatsapp:kb`.

## Inbox support (tableau de bord admin)
Chaque échange (message du visiteur + réponse de l'agent) est copié dans la base de l'Inbox support (`src/salesiq/inboxRecorder.js`, conversation `salesiq:<empreinte>`), à côté des conversations WhatsApp et du chat du site : `harx.ai/admin/inbox`, filtre « SalesIQ », temps réel.
- Non bloquant : la copie se fait sans attente et ne peut jamais retarder ni faire échouer la réponse au visiteur (base indisponible comprise).
- L'identifiant est une empreinte SHA-256 de la clé visiteur SalesIQ : ni e-mail ni identifiant Zoho dans l'URL ou l'interface. Un visiteur non identifiable n'est pas enregistré.
- Mode `shadow` : la réponse de Claude n'est pas envoyée, elle est enregistrée comme « Brouillon non envoyé ». Mode `off` : rien n'est enregistré.
- Une demande que Claude ne peut pas traiter seul (`flag_for_team`) marque la conversation « À traiter » dans l'Inbox.
- Lecture seule côté SalesIQ : pour répondre à un visiteur, utiliser Zoho SalesIQ ; supprimer une conversation dans l'Inbox ne supprime que la copie.
- Ne couvre que les échanges à partir de la mise en service. Désactivable : `SALESIQ_INBOX_RECORD=0`. Le texte des messages reste absent des journaux.

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
| `SALESIQ_INBOX_RECORD` | `0` pour ne pas copier les échanges dans l'Inbox support (défaut : activé) |
| `SALESIQ_LOG_PAYLOAD_SHAPE` | journalise la structure (jamais les valeurs) des webhooks, pour le premier branchement |

Scopes OAuth du Self Client : `SalesIQ.callbacks.UPDATE,SalesIQ.conversations.READ,SalesIQ.conversations.CREATE,SalesIQ.conversations.UPDATE,ZohoCRM.modules.deals.READ`.

## Tests
`npm run salesiq:test` (aucun appel réseau : Claude et Zoho sont simulés).
