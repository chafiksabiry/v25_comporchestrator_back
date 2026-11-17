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
- **Limite connue** : si le propriétaire a quitté la société, sa connexion reste (non orpheline) et personne d'autre ne peut la déconnecter ni connecter la même boîte à sa place (index unique société + fournisseur) ; à traiter, par exemple retrait par le titulaire quand l'ancien propriétaire n'est plus membre — décision à prendre.

## Non vérifié
Migration sur une base réelle (pas de MongoDB dans l'environnement : base simulée) ; Google / Microsoft réels (réseau simulé : routes de l'API non rejouées contre les fournisseurs) ; comportement de l'upsert conditionnel et de l'index unique sur un vrai MongoDB (simulé par le test) ; l'interface du portail (cette PR ne modifie que l'API).

## Points ouverts (relecture adverse) — décisions à prendre
1. **État OAuth non lié au navigateur** (hors périmètre, existant) : un membre peut démarrer `/start` et faire consentir un tiers ; la boîte consentie serait alors à son nom. Correctif possible : nonce en cookie HttpOnly vérifié au callback.
2. **Modification / annulation d'un rendez-vous** par un autre responsable : l'événement est modifié dans le calendrier de son propriétaire mémorisé (jeton du propriétaire). Choix retenu : maintenance de l'événement créé par le système ; alternative stricte : refuser (`failed`) si l'éditeur n'est pas ce propriétaire.
3. **`inbound.*` est un réglage de société** : tout propriétaire d'une boîte peut le régler (pas seulement celui du fournisseur visé).
4. **Agenda automatique** : seules les connexions d'entreprise comptent ; la messagerie personnelle sert via l'agenda délégué (`calendarAccountId`).
5. **Index unique `InboundEmail`** sans `connectionOwnerId` : purge à la reprise d'une orpheline ; index à revoir si plusieurs propriétaires de fournisseurs différents.
6. **Journal d'envoi** (`GET /emails`) : l'adresse de la boîte (`from`) n'est montrée qu'à l'expéditeur ; destinataires et objet restent visibles du titulaire / responsables (inchangé).
