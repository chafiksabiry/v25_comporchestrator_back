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

## Liaison de l'autorisation au navigateur (anti liaison de compte par un tiers)
Avant : un membre pouvait démarrer une connexion et faire consentir quelqu'un d'autre ; la boîte consentie était enregistrée à son nom.
Maintenant, toutes les routes qui démarrent une autorisation (`/connections/.../start`, `/accounts/.../start`, `/accounts/.../:id/reconnect`, `/accounts/.../mine/.../start`, activation de la lecture) sont authentifiées et posent un cookie `harx_oauth_<empreinte>` (HttpOnly, SameSite=Lax, 10 min, `Secure` en https) contenant un secret aléatoire à usage unique ; l'état signé n'en porte que l'empreinte, **liée à l'utilisateur de la session**. Au retour (`/oauth/:provider/callback`) le cookie doit correspondre : sinon `?error=browser_mismatch`, **avant tout échange de code**, rien n'est écrit. Le cookie est consommé (un rejeu est refusé) ; expiration : 10 min (celle de l'état).
- **Prérequis portail** : appeler les routes « start » avec `credentials: 'include'` (CORS autorise déjà les identifiants). Sans cela le navigateur ne conserve pas le cookie et la connexion revient en `browser_mismatch`.
- Interrupteur de secours (rollback sans redéploiement de code) : variable `OAUTH_BROWSER_BINDING=off` (pas de cookie, états sans liaison) — à ne garder que le temps d'adapter le portail.

## Connexions sans `connectedBy` (anciennes) : impacts et reconnexion
Impacts : inutilisables par tous dès le déploiement (envoi, agenda, lecture, e-mails d'accueil et relances, rendez-vous) ; ni adresse ni statut visibles pour personne (le titulaire voit seulement `orphan: true`).
Ce que voit le client : l'écran Outils affiche « non connecté » ; un envoi manuel répond `409 mailbox_not_connected` (« Connectez votre messagerie (Gmail ou Outlook) dans Paramétrage > Outils pour envoyer des e-mails. ») ; e-mails d'accueil / relances : alerte dans l'application seulement ; rendez-vous : `not_connected`.
Procédure :
1. Le responsable qui doit utiliser la boîte ouvre **Paramétrage > Outils** et clique **Connecter** (idéalement avec la même adresse) puis consent : il devient propriétaire (`connectedBy`), la ligne n'est plus orpheline, les anciens e-mails stockés ont été purgés et sont relus pour lui.
2. Compte partagé orphelin : **Reconnecter** (même adresse obligatoire) par un responsable, qui devient propriétaire ; il redéfinit alors la délégation.
3. Boîte à ne plus utiliser : le **titulaire** voit `orphan: true` et clique **Déconnecter** (jetons supprimés, révocation chez le fournisseur au mieux).
4. Chaque autre membre qui veut envoyer connecte sa propre messagerie (profil, « Ma messagerie ») ou reçoit une délégation.

## Propriétaire parti de la société
Le **titulaire** peut déconnecter la connexion (ou retirer le compte partagé) d'un propriétaire qui n'est plus dans l'annuaire de la société (membres + agents, lu chez le service d'inscription avec le jeton du titulaire) ; `GET /connections` lui montre alors `orphan: true`, sans adresse ni jeton. Annuaire illisible ou vide : « inconnu », aucun retrait. Un rendez-vous n'écrit plus dans le calendrier d'un propriétaire parti ni dans celui d'une connexion à refaire : `not_connected`, sans erreur, identifiants conservés.

## Points ouverts
1. `inbound.*` est un réglage de société : tout propriétaire d'une boîte peut le régler (pas seulement celui du fournisseur visé).
2. Agenda automatique : seules les connexions d'entreprise de la personne comptent ; la messagerie personnelle sert via l'agenda délégué (`calendarAccountId`).
3. Index unique `InboundEmail` sans `connectionOwnerId` : purge à la reprise d'une orpheline ; à revoir si plusieurs propriétaires de fournisseurs différents.
4. Journal d'envoi (`GET /emails`) : l'adresse de la boîte (`from`) n'est montrée qu'à l'expéditeur ; destinataires et objet restent visibles du titulaire / responsables (inchangé).
5. La liaison au navigateur suppose que le portail envoie les identifiants (voir plus haut) ; non testable ici avec un vrai navigateur.
