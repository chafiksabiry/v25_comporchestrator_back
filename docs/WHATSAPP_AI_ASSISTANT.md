# HARX WhatsApp AI Assistant — architecture et mise en service

Claude est le cerveau, WhatsApp le canal, la base de connaissances HARX la source de vérité.

## Architecture
```
Utilisateur ─ WhatsApp ─▶ Meta Cloud API ──webhook signé──▶ POST /api/whatsapp/webhook   (orchestrateur)
                                                              │ 1. signature X-Hub-Signature-256 (corps brut) → 401 sinon
                                                              │ 2. 200 immédiat ; dédoublonnage par wamid ; file par numéro
                                                              ▼
 agent.js : liaison de compte → détection de langue (CHAQUE message) → contexte (historique, notes, compte lié)
        ▼
 Claude (SDK @anthropic-ai/sdk, boucle d'outils) ── search_knowledge / read_knowledge_topic (BM25 sur kb/)
        │                                          get_subscription_plans (catalogue live)
        │                                          get_my_account_overview (compte LIÉ uniquement, droits relus à chaque usage)
        │                                          remember_fact / escalate_to_human / unlink_whatsapp_account
        ▼
 contrôle de langue de la réponse (régénération si mauvaise langue) → format WhatsApp → découpage → Graph API
```
Site : le bouton flottant (hôte `v25_process_connections`) ouvre `wa.me/212711311388`. Connecté, il appelle `POST /api/whatsapp/link-token` (JWT) et ajoute un code à usage unique `HARX-XXXXXXXX` au message ; ce code, reçu sur WhatsApp, lie le numéro au compte. Sans lien : mode visiteur (aucune donnée de compte).

Code : `src/whatsapp/` (config, language, agent, tools, identity, knowledgeBase `knowledge/`, stores Mongo/mémoire, routes), contenu : `src/whatsapp/kb/` (17 rubriques rédigées + `generated/`), outils : `scripts/`.

## Sécurité (résumé)
Webhook signé (HMAC, temps constant) ; jetons/clés uniquement en variables d'environnement ; outils en lecture seule (l'agent ne peut pas « faire » d'action) ; identifiants société/utilisateur jamais pris dans les arguments du modèle ; jeton JWT de 2 min au nom de l'utilisateur lié ; code de liaison à usage unique, 30 min ; limite de débit par numéro ; messages entrants tronqués ; routes admin désactivées sans `WHATSAPP_ADMIN_API_KEY`.

## Variables d'environnement
| Variable | Rôle |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Cloud API (jeton système permanent recommandé) |
| `WHATSAPP_VERIFY_TOKEN` | jeton choisi, saisi dans la console Meta (vérification GET) |
| `WHATSAPP_APP_SECRET` | secret de l'app Meta, vérifie la signature des webhooks |
| `ANTHROPIC_API_KEY` | API Claude ; `WHATSAPP_CLAUDE_MODEL` (défaut `claude-opus-5-5`), `WHATSAPP_CLAUDE_EFFORT` (défaut `low`) |
| `JWT_SECRET`, `REGISTRATION_BACKEND_URL` | déjà utilisés par l'orchestrateur |
| `WHATSAPP_ADMIN_API_KEY` | active `/api/whatsapp/admin/*` (tickets, réponse humaine) |
| `WHATSAPP_SUPPORT_NOTIFY_WEBHOOK_URL`, `SUPPORT_EMAIL` | notification des escalades (webhook type Slack) / adresse citée aux utilisateurs |
| `WHATSAPP_SUPPORT_NUMBER` (défaut 212711311388), `WHATSAPP_RATE_LIMIT_PER_MINUTE` (10), `WHATSAPP_RATE_LIMIT_PER_DAY` (200), `WHATSAPP_CLAUDE_REFUSAL_FALLBACK` (0) | réglages |
Site : `VITE_API_URL_ORCHESTRATOR`, `VITE_WHATSAPP_SUPPORT_NUMBER`.

## À faire côté Meta (impossible depuis le code)
1. Compte Meta Business vérifié ; app « Business » avec le produit WhatsApp ; enregistrer **+212 711 311 388** sur la Cloud API (un numéro enregistré sur la Cloud API ne peut plus être utilisé dans l'application WhatsApp classique).
2. Webhook : URL `https://<orchestrateur>/api/whatsapp/webhook`, jeton = `WHATSAPP_VERIFY_TOKEN`, champ `messages` abonné.
3. Fenêtre de 24 h : l'assistant répond librement dans les 24 h suivant le dernier message de l'utilisateur ; au-delà, Meta exige un modèle (template) approuvé — non couvert ici.

## Base de connaissances
`npm run whatsapp:kb -- <dossier des dépôts v25_*>` régénère routes, permissions, messages d'erreur, énumérations et textes d'interface depuis le code ; `npm run whatsapp:kb:check` signale les rubriques dont les fichiers source ont disparu. Les rubriques rédigées portent `sources:` et `verified:` ; les zones non confirmées sont listées dans `kb/coverage-and-limits.md`.

## Tests
`npm run whatsapp:test` : langue (corpus fr/en/es/de/it/pt/ar/Darija arabe et latin/mélanges/changements), unités (signature, découpage, formats, stockage, KB, liaison), bout en bout HTTP (vrai Express, fausse Graph API, fausse API d'inscription, « Claude » scripté : webhook signé, doublons, changement de langue, régénération, liaison et isolation entre comptes, escalade, pannes, débit, concurrence).
`ANTHROPIC_API_KEY=… npm run whatsapp:live-test` : mêmes parcours avec la **vraie** API Claude (transport WhatsApp simulé).
