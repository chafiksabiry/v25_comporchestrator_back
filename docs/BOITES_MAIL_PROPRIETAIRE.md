# Boîtes mail connectées : utilisables par leur seul propriétaire

Exigence du propriétaire du produit : *« il ne faut pas laisser les sessions de mails ouvertes pour d'autres membres d'une même société (dans les offres Téléphonie ou TAAS) »*.

## Règle

Une boîte Google ou Microsoft connectée n'est utilisable que par **la personne qui l'a connectée** (`connectedBy`, identifiant de la session OAuth). Le rôle (titulaire, responsable, secrétaire) ne donne aucun droit sur la boîte d'un autre. Code : `src/services/mailOwnership.js`.

| Objet | Propriétaire | Autres membres |
|---|---|---|
| Connexion d'entreprise (`SecretariatConnection`, Google / Microsoft) | `connectedBy` | voient « non connecté » ; ni envoi, ni agenda, ni lecture, ni reconnexion, ni déconnexion |
| Compte partagé / délégué (`SecretariatSharedAccount`) | `connectedBy` | seulement ce que le propriétaire a délégué (`permissions.send` / `permissions.calendar`), **y compris les responsables** ; jamais de gestion |
| Messagerie personnelle (`personalUserId`) | l'utilisateur | rien (« introuvable »), titulaire compris |
| Zoom | inchangé (hors « boîte mail ») | inchangé |

Le jeton n'est jamais remis à un autre : `getAccessToken` / `withConnection` exigent un `ownerId` pour toute connexion Google / Microsoft de l'entreprise (sinon `not_connected`), et la clé de partage des requêtes en vol l'inclut.

### Connexion orpheline (`connectedBy` vide)
Inutilisable par tous. Le **titulaire** de la société (rôle `owner`) peut seulement (a) voir qu'elle existe (`orphan: true`, sans adresse, dans `GET /connections`) et (b) la **déconnecter**. Un responsable peut la **reconnecter** (il devient propriétaire) ; pour un compte partagé orphelin, l'adresse doit être la même qu'avant.

### Connexion d'une autre personne
`POST /connections/:id/:provider/start` répond `409 connection_owned` (ni adresse ni identité) ; au retour OAuth, `?error=not_owner`, jeton et adresse du propriétaire intacts. L'écriture est conditionnelle (`connectedBy`) et l'index unique `{société, fournisseur}` refuse l'écrasement concurrent.

### Réglage `inbound.secretaries`
Sans effet et refusé à `true` (`400`) ; remis à `false` par la migration ; jamais exposé comme actif. `inbound.*` ne se règle pas quand la boîte appartient à un autre.

## E-mails automatiques
- **Message d'accueil** : part de la boîte de la personne qui a pris le message (sa connexion, sinon sa messagerie personnelle) ; sinon `not_connected` (alerte dans l'application seulement, aucune erreur).
- **Relances** : depuis la boîte de celui qui a **créé** l'élément (`createdById`), jamais celle d'un autre ; sans boîte, aucune relance par e-mail.

## Rendez-vous
Création : agenda de la personne **assignée**, sinon de celle qui **crée**, si elle a connecté une boîte Google / Microsoft ; sinon `calendarStatus = not_connected`. Le propriétaire est mémorisé (`calendarOwnerId`, `videoOwnerId`) : modification / annulation retournent dans ce calendrier. Rendez-vous antérieurs (sans propriétaire mémorisé) : propriétaire actuel de la connexion de ce fournisseur, jamais une connexion orpheline. L'agenda délégué (`calendarAccountId`) reste le seul moyen d'écrire dans l'agenda d'un autre. Lien Meet / Teams : boîte de celui qui le crée.

## E-mails entrants stockés
`InboundEmail.connectionOwnerId` : tout e-mail stocké de la boîte de l'entreprise porte son propriétaire ; les requêtes filtrent dessus. Un non-propriétaire reçoit la même réponse que « aucune messagerie connectée » (`no_mailbox`, liste vide), qui ne révèle pas qu'une boîte existe.

## Migration (démarrage, idempotente, journal sans donnée personnelle)
`src/services/mailOwnershipMigration.js` → une ligne `mail_ownership_applied` avec des compteurs :
1. connexions Google / Microsoft et comptes partagés sans `connectedBy` : marqués `ownerless` (jamais rattachés à quelqu'un) ;
2. e-mails entrants d'entreprise sans `connectionOwnerId` : purgés (métadonnées TTL 30 j, relues pour le propriétaire au prochain rafraîchissement) ; messageries personnelles intactes ;
3. `inbound.secretaries` remis à `false`.
Les lignes qui ont un `connectedBy` gardent ce propriétaire. Aucun changement d'index.

## Impact sur les clients existants
- **Connexion d'entreprise actuelle** : son connecteur (`connectedBy`) en devient le propriétaire. Les autres responsables et les secrétaires **perdent** l'usage de cette boîte (envoi, agenda, lecture) et ne voient plus son adresse. Pour envoyer, chacun connecte sa propre messagerie (« Ma messagerie » dans son profil, désormais ouverte aux titulaires et responsables) ou reçoit une délégation (compte partagé).
- **E-mails d'accueil et relances** : ne partent que si la personne concernée a connecté une boîte ; sinon l'alerte dans l'application seule (comportement `not_connected` existant) — attendu chez les clients dont seule la boîte d'entreprise servait.
- **Rendez-vous** : synchronisés seulement avec l'agenda d'une personne qui a connecté une boîte ; sinon `not_connected`.
- **Comptes partagés** : un responsable ne voit plus ceux des autres sans délégation ; `permissions.send` / `permissions.calendar` s'appliquent désormais aux responsables.
- **Connexion orpheline** (anciennes lignes sans `connectedBy`) : inutilisable jusqu'à reconnexion.

## Non vérifié
Migration sur une base réelle (pas de MongoDB dans l'environnement : base simulée) ; Google / Microsoft réels (réseau simulé : routes de l'API non rejouées contre les fournisseurs) ; comportement de l'upsert conditionnel et de l'index unique sur un vrai MongoDB (simulé par le test) ; l'interface du portail (cette PR ne modifie que l'API).

## Finalisation authentifiée de l'autorisation OAuth (contrat portail)
Problème : le retour du fournisseur arrive dans le navigateur de la personne qui consent, qui peut être un tiers ; un membre pouvait ainsi faire lier la boîte d'un collègue à son propre compte. Le portail (Netlify) et l'API (Railway) étant sur des domaines différents, un cookie n'est pas fiable : **aucun cookie, `credentials: 'include'` inutile**.

Flux en deux temps (toutes les autorisations : connexion d'entreprise, compte partagé, reconnexion, messagerie personnelle, activation de la lecture) :
1. **Démarrage** (inchangé côté portail) : `POST /connections/:id/:provider/start`, `POST /accounts/:id/:provider/start`, `POST /accounts/:id/:accountId/reconnect`, `POST /accounts/:id/mine/:provider/start`, `POST /accounts/:id/mine/inbound/:accountId/enable` → `{ success, data: { url } }` ; le portail redirige le navigateur vers `url`.
2. **Retour du fournisseur** : `GET /oauth/:provider/callback` (public) échange le code, met les jetons **chiffrés** en attente (collection `secretariat_oauth_pending`, identifiant aléatoire à usage unique, **TTL 10 min**, lié à l'utilisateur qui a démarré et à la société ; seule son empreinte SHA-256 est stockée) et redirige vers la page de retour du portail avec **`?pending=<identifiant>&provider=<google|microsoft>`**. **Rien n'est enregistré à ce stade** (pas de `connected=`). Les erreurs du fournisseur gardent `?error=<code>` (`invalid_state`, `invalid_request`, `access_denied`, `unavailable`, `exchange_failed`, `no_refresh_token`, `missing_permissions`, `no_account`, `storage_failed`).
3. **Finalisation** (NOUVEAU, à appeler par le portail dès qu'une page de retour contient `pending`) : `POST /api/secretariat/connections/:companyId/:provider/complete` avec l'en-tête `Authorization: Bearer <jeton de l'utilisateur>` et le corps JSON `{ "pendingId": "<identifiant>" }` (`:provider` = valeur de `provider` du retour). L'attente est **consommée dans tous les cas** (un seul essai).
   - `200` `{ success: true, data: { connected: "google|microsoft", personal?: true, read?: true, shared?: true } }` (mêmes indications que les anciens `?connected=…&personal=1&read=1&shared=1`).
   - Erreurs `{ success: false, code, error: code, message }` : `400 invalid_request` (identifiant absent / mal formé) · `401` (non authentifié, attente intacte) · `403 wrong_user` (l'utilisateur authentifié n'est pas celui qui a démarré : attente détruite, rien n'est lié) · `403 not_owner` (la connexion / le compte appartient à une autre personne) · `403 forbidden` (droits retirés entre-temps) · `404 pending_not_found` (inconnue, expirée, forgée, déjà utilisée, autre société ou autre fournisseur) · `409 email_in_use` / `wrong_account` / `too_many_accounts` / `unavailable` · `500 storage_failed`.
   - Contrôles à la finalisation : utilisateur authentifié = démarreur, droits revérifiés, contrôle de propriété (`mayTakeOver`) et écriture conditionnelle (index unique).
Un tiers qui fait consentir un collègue n'obtient rien : l'identifiant part dans le navigateur de la victime, qui n'a pas le jeton du démarreur (`wrong_user`).
- **Rollback sans redéploiement** : `OAUTH_BROWSER_BINDING=off` → les états ne demandent plus de finalisation (enregistrement direct au callback avec `?connected=…`, comme avant). À ne garder que le temps d'adapter le portail. **Tant que le portail n'appelle pas `complete`, aucune connexion n'est enregistrée avec le comportement par défaut** : à déployer avec le portail (ou avec l'interrupteur à `off`).

## Connexions sans `connectedBy` (anciennes) : impacts et reconnexion
Impacts : inutilisables par tous dès le déploiement (envoi, agenda, lecture, e-mails d'accueil et relances, rendez-vous) ; ni adresse ni statut visibles pour personne (le titulaire voit seulement `orphan: true`).
Ce que voit le client : l'écran Outils affiche « non connecté » ; un envoi manuel répond `409 mailbox_not_connected` (« Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails. ») ; e-mails d'accueil / relances : alerte dans l'application seulement ; rendez-vous : `not_connected`.
Procédure :
1. Le responsable qui doit utiliser la boîte ouvre **Paramétrage > Outils** et clique **Connecter** (idéalement avec la même adresse) puis consent : il devient propriétaire (`connectedBy`), la ligne n'est plus orpheline, les anciens e-mails stockés ont été purgés et sont relus pour lui.
2. Compte partagé orphelin : **Reconnecter** (même adresse obligatoire) par un responsable, qui devient propriétaire ; il redéfinit alors la délégation.
3. Boîte à ne plus utiliser : le **titulaire** voit `orphan: true` et clique **Déconnecter** (jetons supprimés, révocation chez le fournisseur au mieux).
4. Chaque autre membre qui veut envoyer connecte sa propre messagerie (profil, « Ma messagerie ») ou reçoit une délégation.

## Propriétaire parti de la société
Le **titulaire** peut déconnecter la connexion (ou retirer le compte partagé) d'un propriétaire qui n'est plus dans l'annuaire de la société (membres + agents, lu chez le service d'inscription avec le jeton du titulaire) ; `GET /connections` lui montre alors `orphan: true`, sans adresse ni jeton. Annuaire illisible, **partiel** (une seule des deux listes membres / agents lue) ou vide : « inconnu », aucun retrait ; « parti » seulement si les deux listes ont été lues et que la personne n'est dans aucune. Un rendez-vous n'écrit plus dans le calendrier d'un propriétaire parti ni dans celui d'une connexion à refaire : `not_connected`, sans erreur, identifiants conservés.

## Réglages globaux, purge, journal, existence (revue indépendante)
- **Réglages de société** : `inbound.*` et tout fournisseur externe (`email.provider`, `agenda.provider`, `visio.provider` ≠ platform/none/jitsi/custom) ne se changent que par le **titulaire** (`403` sinon). Un propriétaire de boîte non titulaire ne peut ni couper la lecture d'une autre boîte ni purger ses e-mails stockés. La désactivation par le titulaire purge tous les e-mails stockés de l'entreprise (`ALL_OWNERS`, jamais les messageries personnelles). Les réglages sans fournisseur (nom d'expéditeur, signature…) restent ouverts aux responsables.
- **Purge ciblée** : `purgeInboundEmails(société, propriétaire)` — propriétaire explicite obligatoire ; sans propriétaire = seulement les anciens e-mails sans `connectionOwnerId` ; « tout » seulement avec `ALL_OWNERS`. Déconnexion : les e-mails de la boîte déconnectée ; reprise d'une orpheline : les anciens e-mails sans propriétaire.
- **Journal d'envoi** (`GET /emails`) : destinataires, objet, nom de l'expéditeur et adresse de la boîte ne sont montrés qu'à l'auteur ; pour les autres (titulaire compris), entrée « totaux » (`masked: true` : date, modèle, état, élément lié).
- **Anciens rendez-vous** (propriétaire d'agenda non mémorisé) : jamais deviné ; modification / annulation = `not_connected`, rien d'écrit.
- **Fuite d'existence ACCEPTÉE et documentée** : un non-propriétaire apprend qu'une connexion existe chez un autre membre par `POST …/start` (`409 connection_owned`), `DELETE` (`403 not_owner`), le retour OAuth (`?error=not_owner`) et `email_in_use` (compte partagé) ; c'est inévitable tant qu'il ne peut y avoir qu'une connexion par fournisseur et par société (index unique) et que l'on doit lui dire pourquoi l'action est refusée. **Jamais l'adresse, le statut ni l'identité du propriétaire.** Pour les e-mails entrants, la réponse est identique à « aucune messagerie ».

## Points ouverts
1. Agenda automatique : seules les connexions d'entreprise de la personne comptent ; la messagerie personnelle sert via l'agenda délégué (`calendarAccountId`).
2. Index unique `InboundEmail` sans `connectionOwnerId` (purge à la reprise d'une orpheline) : à revoir si plusieurs propriétaires de fournisseurs différents lisent en même temps.
3. La finalisation suppose que le portail appelle `complete` au retour OAuth (contrat ci-dessus) ; non testable ici avec le vrai portail. Index TTL `secretariat_oauth_pending` créé à l'initialisation du modèle (vérifier `autoIndex` en recette).

## Google : lecture pour le titulaire de la boîte, délégation suspendue

- **Lecture Gmail rétablie** (scope `gmail.readonly`, optionnel, `read: true`) avec l'envoi (`gmail.send`) et l'agenda : boîte d'entreprise ou messagerie personnelle, lisible par **la seule personne qui l'a connectée** (règle ci-dessus). `gmail.modify` n'est jamais demandé : `write: true` est refusé pour Google (400) et, même avec `inbound.mailboxActions`, suppression / archivage d'un e-mail Gmail restent dans HARX (`mailbox: 'app_only'`).
- L'ancienne migration « Google sans lecture » (`googleInboxMigration.js`) est **sans effet** et n'est plus appelée au démarrage : elle ne purge ni ne neutralise plus rien.
- **Délégation Google suspendue** tant que Google n'a pas vérifié l'application (`src/services/googleDelegation.js`, `GOOGLE_DELEGATION_ENABLED=1` pour la réactiver) : comptes partagés Google (nouveau, reconnexion, droit accordé : `409 google_delegation_disabled` ; usage par un autre que le propriétaire : `403 google_delegation_disabled`), rendez-vous dans « l'agenda d'un collègue » Google, agenda Google de la personne assignée quand une autre personne crée / modifie / annule (`calendarStatus: not_connected`, identifiants conservés), événement Meet dédié d'un collègue. Rien n'est supprimé ; Microsoft inchangé.
- **Aucune donnée Google envoyée à une IA** (`src/services/googleAiPolicy.js`) : le corps d'un e-mail Gmail demandé avec `?purpose=ai` répond `409 google_ai_disabled` avant tout appel Gmail ; chaque e-mail (liste, corps) porte `aiAllowed` (faux pour Gmail). Ce serveur n'envoie lui-même aucun e-mail à une IA : tout service d'analyse doit respecter ce drapeau.
- `GET /connections` : un non-propriétaire voit `ownedByOther: true` (booléen seul, ni adresse ni identité) quand la boîte du fournisseur appartient à un autre membre.
- Retrait d'un lien de visio (`PATCH /follow-ups/:id { videoLink: false }`) impossible (délégation Google suspendue ou panne) : champs visio conservés, réponse `videoRemoval: { status: 'not_removed', code: 'google_delegation_disabled' | 'provider_error', message }`.
