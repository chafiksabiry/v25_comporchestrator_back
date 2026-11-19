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

## Chat sur le site (sans redirection vers l'application WhatsApp)
Même agent que sur WhatsApp (Claude, base de connaissances, langue, escalade), mais le visiteur écrit dans un panneau du site ; aucun message n'est envoyé à Meta (`src/whatsapp/webChat.js`, montée sur `/api/whatsapp/web-chat`).
- `POST /web-chat/message` `{ sessionId, message }` -> `{ reply, handoff }` ; `GET /web-chat/:sessionId/messages[?after=ISO]` -> historique (réponses de l'équipe support comprises) ; `GET /web-chat/config`.
- `sessionId` : identifiant aléatoire (22 à 64 caractères `A-Za-z0-9_-`) créé par le navigateur ; la conversation est stockée sous `web:<sessionId>`.
- Mode visiteur uniquement : pas de liaison de compte, aucune donnée de compte accessible.
- Débit : par session (celui de l'agent) et par IP (`WHATSAPP_WEB_RATE_LIMIT_PER_MINUTE` 12, `WHATSAPP_WEB_RATE_LIMIT_PER_DAY` 150) pour protéger le coût Claude.
- Les tickets d'escalade d'un visiteur web se traitent avec les mêmes routes admin ; la réponse humaine est lue par le navigateur (aucun envoi Meta).
- Mode `WHATSAPP_HUMAN_MODE` : le message est enregistré (202), sans appel à l'API Anthropic.

## Boîte de réception du support (lecture des conversations)
Page `GET /api/whatsapp/admin/inbox` (statique, sans donnée) : saisir la clé `WHATSAPP_ADMIN_API_KEY` (gardée en sessionStorage, envoyée en en-tête `x-admin-key`). Elle liste les conversations WhatsApp et du chat du site, avec leur historique. Routes JSON : `GET /admin/conversations[?channel=web|whatsapp&limit=]` et `GET /admin/conversations/:id`. Désactivée (404) sans `WHATSAPP_ADMIN_API_KEY`.
`DELETE /admin/conversations/:id` supprime définitivement une conversation et ses tickets d'escalade (irréversible ; admin uniquement).
Les routes `/admin/*` acceptent aussi la connexion admin du tableau de bord HARX (`Authorization: Bearer <JWT>` émis par le service d'inscription avec `typeUser: 'admin'`) : c'est ce qu'utilise la page « Inbox » de `harx.ai/admin`, sans saisie de clé.

### Temps réel (WebSocket `/support-inbox`)
L'Inbox du tableau de bord reçoit un signal dès qu'un message arrive, qu'une conversation est transmise à un humain, qu'un ticket change ou qu'une conversation est supprimée. Connexion : `new WebSocket(url, ['bearer', <jeton admin>])` (sous-protocole uniquement, jamais `?token=`) ; refus 401 sans jeton admin ; fermeture 4401 à l'expiration du jeton ; ping toutes les 30 s. Le serveur n'envoie que `{ type: 'inbox.changed', waId, reason }` (reason : `message`, `handoff`, `ticket`, `deleted`), sans contenu : le client relit les données par les routes HTTP authentifiées. Code : `src/websocket/supportInbox.js`, évènements : `src/whatsapp/events.js` (le store est enveloppé dans `createWhatsAppModule`). Les serveurs WebSocket (escrow et Inbox) sont en mode `noServer` ; `upgradeFallback.js` refuse (400) les autres chemins.

### Copie du chat du site vers WhatsApp (Meta)
Un visiteur du site n'a pas de numéro : Meta ne peut rien lui envoyer. En revanche chaque échange du chat (message du visiteur + réponse de l'assistant) peut être **copié par l'API WhatsApp Business vers un numéro de l'équipe**, pour suivre le chat du site depuis WhatsApp (`src/whatsapp/webMirror.js`).
- `WHATSAPP_WEB_MIRROR_NUMBER` : numéro de l'équipe (E.164, « + » et espaces ignorés). Vide = désactivé (rien n'est envoyé à Meta).
- Fenêtre de 24 h : un texte libre n'est accepté que si ce numéro a écrit au numéro HARX dans les dernières 24 h (erreur Meta 131047 sinon). Pour ne pas dépendre de cela, créez un modèle approuvé avec UN paramètre de corps `{{1}}` et indiquez-le dans `WHATSAPP_WEB_MIRROR_TEMPLATE` (langue : `WHATSAPP_WEB_MIRROR_TEMPLATE_LANG`, défaut `fr`) ; il prend le relais quand la fenêtre est fermée (messages hors fenêtre : facturés par Meta selon sa grille).
- `WHATSAPP_WEB_MIRROR_MAX_PER_HOUR` (défaut 200) : plafond de copies par heure.
- La copie est en arrière-plan : un échec ne retarde ni n'altère la réponse au visiteur (avertissement au plus une fois par 10 min).
- Les messages écrits par ce numéro d'équipe ne sont pas traités par l'assistant (pas de réponse, pas de boucle) ; ils ouvrent quand même la fenêtre de 24 h.
- Les visiteurs sont informés dans le panneau du chat que leurs messages peuvent être transmis à l'équipe via WhatsApp.

## Base de connaissances
`npm run whatsapp:kb -- <dossier des dépôts v25_*>` régénère routes, permissions, messages d'erreur, énumérations et textes d'interface depuis le code ; `npm run whatsapp:kb:check` signale les rubriques dont les fichiers source ont disparu. Les rubriques rédigées portent `sources:` et `verified:` ; les zones non confirmées sont listées dans `kb/coverage-and-limits.md`.

## Tests
`npm run whatsapp:test` : langue (corpus fr/en/es/de/it/pt/ar/Darija arabe et latin/mélanges/changements), unités (signature, découpage, formats, stockage, KB, liaison), bout en bout HTTP (vrai Express, fausse Graph API, fausse API d'inscription, « Claude » scripté : webhook signé, doublons, changement de langue, régénération, liaison et isolation entre comptes, escalade, pannes, débit, concurrence).
`ANTHROPIC_API_KEY=… npm run whatsapp:live-test` : mêmes parcours avec la **vraie** API Claude (transport WhatsApp simulé).
