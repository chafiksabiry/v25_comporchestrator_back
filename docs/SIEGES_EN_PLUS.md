# Sièges en plus (facturation mensuelle)

## Règle métier

- Chaque offre Call Centre inclut **1 siège** : le titulaire.
- Un siège = une personne rattachée au centre : membres et agents, invités ou actifs, titulaire compris (même règle que `seatsUsed` dans le front, `src/domain/plans.ts`). Une personne ne compte qu'une fois.
- **Nomad Solo** : aucun siège en plus (bloqué à l'inscription des invités et ignoré ici).
- **Accueil, Full Scope, Multi-clients** : chaque siège au-delà du premier est facturé chaque mois, au prorata en cours de période.
- Quantité facturée = `max(0, sièges utilisés − 1)`.
- **Le code promo de lancement ne s'applique pas aux sièges** (décision). Il est saisi à l'abonnement et ne passe jamais par ce service ; voir « Côté Stripe » pour que Stripe ne l'applique pas non plus.

## Où est calculé le nombre de sièges

Décision : calcul **côté serveur, dans l'orchestrateur**, jamais envoyé par le navigateur. Vérifié dans `v25_registration_backend` : le service d'inscription et l'orchestrateur lisent la **même base MongoDB** (`companyProduct.js` y lit déjà `subscriptions` et `subscriptionplans` écrites par l'orchestrateur ; l'orchestrateur lit déjà `companies`). Collections lues (lecture seule) :

| Collection | Usage |
| --- | --- |
| `companies` | `userId` du titulaire |
| `companymemberships` | membres rattachés (hors titulaire) |
| `users` | agents : `employerCompanyId` = centre et `typeUser = 'rep'` |
| `agentinvitations` | invitations de membre en attente ; invitations d'agent en attente ou acceptées |

Mêmes règles que les listes du service d'inscription (`companyMemberService.list`, `callCenterAgentService.listAgents`). Si ces règles changent côté inscription, adapter `countSeatsUsed` dans `src/services/seats.js`.

## Routes (orchestrateur, JWT obligatoire)

- `GET /api/subscriptions/seats` : titulaire et membres. Renvoie `used`, `included` (1), `extra`, `unitPrice` (en euros, lu dans Stripe), `monthlyTotal`, `currency`, `billedQuantity` (quantité réellement présente dans Stripe), `applicable`, `configured`, `message`.
- `POST /api/subscriptions/seats/sync` : **titulaire seulement** (403 sinon). Aligne la ligne d'abonnement Stripe sur la quantité cible et renvoie l'état avec `action` : `created`, `updated`, `removed`, `unchanged` ou `skipped`.

Le centre est celui de l'appelant (service d'inscription), jamais un identifiant du corps de la requête. La synchronisation ne renvoie **jamais d'erreur bloquante** : si Stripe échoue, réponse 200 avec `success: false` et `action: 'failed'` ; l'invitation reste valide et la facturation se rattrape à la prochaine synchronisation.

L'application appelle `POST /seats/sync` après chaque invitation ou retrait d'un membre ou d'un agent.

## Fonctionnement de la synchronisation

1. Abonnement le plus récent du centre en statut `active` ou `trialing` (sinon : ignoré). Le palier vient des métadonnées du plan (`harx_product=callcenter`, `callcenter_tier`). Nomad Solo : ignoré.
2. Le prix du siège est **retrouvé par recherche des produits Stripe actifs** portant `harx_product=callcenter_seat` et `seat_for_tier=<palier>`, puis leur prix mensuel (`default_price`, sinon premier prix récurrent mensuel actif). Aucun identifiant de prix n'est écrit dans le code ; résultat gardé 5 minutes en mémoire.
3. Si aucun produit siège n'existe pour le palier (ou si Stripe n'est pas configuré ou ne répond pas) : **repli « facturation des sièges non configurée »**, aucune facturation, message clair, aucune erreur.
4. Sinon, sur l'abonnement Stripe : ligne absente et quantité > 0 → `subscriptionItems.create` ; quantité différente → `update` ; quantité 0 → suppression de la ligne. Toujours avec `proration_behavior: create_prorations` : le complément est ajouté à la prochaine facture (« facturés à la prochaine échéance, au prorata »).
5. Idempotent : la quantité cible est comparée à celle de Stripe, sans écriture si elle est déjà bonne. Les synchronisations d'un même centre sont mises en file (verrou par centre dans le processus), donc deux invitations rapprochées ne créent pas deux lignes.
6. La ligne créée porte `metadata.harx_product=callcenter_seat`. `subscriptionFulfillment.js` ignore cette ligne pour retrouver le forfait (`pickPlanItem`), et les produits siège ne sont pas inscrits comme forfaits (`isCallcenterProduct` exige `harx_product=callcenter`).

## Côté Stripe (à vérifier en recette)

- Un produit par palier, actif, avec les métadonnées `harx_product=callcenter_seat` et `seat_for_tier` (`accueil`, `full_scope` ou `multi_clients`), et un prix **mensuel** récurrent actif (prix par défaut de préférence). Prix prévus : 39 € / 59 € / 79 € par mois.
- La clé Stripe de l'orchestrateur doit pouvoir lire produits et prix et modifier `subscription_items`.
- **Code promo de lancement** : un coupon au niveau de l'abonnement s'applique à toutes les lignes, sièges compris. Pour respecter la décision, le coupon doit être limité aux produits des forfaits (`applies_to.products`). L'état renvoie `discountMayApplyToSeats: true` quand l'abonnement porte une remise, pour le repérer.
- En essai (`trialing`), la ligne est ajoutée mais rien n'est facturé avant la fin de l'essai.
- Un siège ajouté au milieu de la période est facturé au prorata sur la prochaine facture ; retirer un siège crée un avoir proratisé.

## Tests

`npm test` exécute `src/tests/seats.test.js` : calcul des sièges, quantités, idempotence, concurrence, repli sans configuration, Nomad Solo, abonnement annulé, droits des routes. Le client Stripe et la base sont **simulés** : aucun appel réel.
