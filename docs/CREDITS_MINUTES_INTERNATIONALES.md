# Crédit minute international = N crédits minute nationale

Recette uniquement à ce stade. Remplace le second solde / les packs internationaux (PR #143, non fusionnée) : **un seul solde de minutes** (`MinutesCompany`, packs et achats à la minute existants inchangés).

## Règle (décision du propriétaire)

- Un appel **international** débite **N crédits par minute** : minute entamée arrondie à la minute supérieure, **puis** multipliée par N (61 s à N=4 : 2 min × 4 = 8 crédits).
- Un appel **national, UE ou DOM-TOM (y compris les collectivités d'outre-mer : +508, +687, +689, +681, décision du propriétaire)** débite **1 crédit par minute**, comme aujourd'hui.
- Zone : voir « Classification ». Entrants : coefficient national (1) **sauf provenance internationale lisible** (choix documenté ci-dessous).
- Idempotence inchangée : une clé par appel (`sid`), débit atomique (`chargedCallSids`).

## Le coefficient N n'est pas écrit en dur

Ordre de lecture : **métadonnée Stripe `international_minute_credits` du produit du forfait**, sinon **variable d'environnement `INTERNATIONAL_MINUTE_CREDITS`**, sinon **1**. Borne : entier entre 1 et 100 ; valeur invalide (métadonnée ou variable) → **1 + avertissement** `[credits]` (une métadonnée invalide ne bascule pas sur la variable d'environnement : on ne devine pas l'intention).

**Déploiement sans changement** : sans métadonnée ni variable, N = 1 et **tout est strictement inchangé** (testé pour les 4 offres). On passe ensuite à la valeur voulue en configuration (par exemple `INTERNATIONAL_MINUTE_CREDITS=4`, ou la métadonnée sur le produit d'une offre). Le coefficient est relu à chaque comptage (pas de cache applicatif propre à cette fonction ; un changement d'environnement demande un redémarrage, un changement de métadonnée passe par la synchronisation des forfaits existante).

## Classification

- **Sortants** : zone de la destination, jugée depuis la **ligne réellement utilisée** par l'appel (champ `from` de l'appel stocké ; au moment de décider, la ligne qui va passer l'appel). Si `from` n'est pas un numéro lisible (par exemple `client:…`), **repli documenté** sur la première ligne lisible de l'entreprise. Le résultat ne dépend donc pas de l'instant de la synchro.
- **Domestique** : même pays ; États-Unis ↔ Canada ; pour une entreprise de l'UE, les 27 pays de l'UE (`src/services/euCountries.js`, codes ISO, Royaume-Uni absent) ; DOM-TOM **+262, +590, +594, +596, +508, +687, +689, +681 traités comme la France** (décision du propriétaire : nationaux pour une entreprise française, collectivités hors UE comprises) (limite connue : Saint-Barthélemy, hors UE, et la partie française de Saint-Martin partagent +590 avec la Guadeloupe).
- **International** : tout le reste (Royaume-Uni, Suisse, Norvège… ; entreprise hors UE appelant l'UE comprise).
- **Territoires** : le pays est identifié par `callingInfoOf` (`outboundDestinations.js`) à partir du numéro complet : pour une entreprise +1, seuls les **États-Unis et le Canada sont domestiques entre eux** ; Jamaïque, Bahamas, Porto Rico, République dominicaine, Trinité-et-Tobago… sont **internationaux** ; +7 distingue Russie et Kazakhstan ; +262 distingue La Réunion et Mayotte (toutes deux la France). `+44` n'est pas subdivisé par la table (Jersey, Guernesey, île de Man comptent comme le Royaume-Uni).
- **Aucun pays identifiable** (indicatif absent de la table, ou indicatif partagé fourni seul sans numéro complet) : **domestique par prudence** (aucun surcoût sur une donnée inconnue), avec avertissement `[zone]`.
- **Entreprise sans ligne lisible et appel sans `from` lisible** : zone inconnue, jamais supposée dans l'UE → **1 crédit** + avertissement.
- **ENTRANTS : toujours 1 crédit par minute**, quelle que soit la provenance. Décision par défaut du propriétaire : le périmètre voulu ne porte que sur les appels **sortants** vers l'international ; un débit appliqué après coup à un entrant, sans pré-contrôle possible, pourrait rendre le solde négatif sans décision. La lecture de la provenance est donc désactivée.

## Où le coefficient s'applique

| Point | Effet |
| --- | --- |
| Lecture du solde (`syncMinutesFromCalls`) | crédits de chaque appel sortant = minutes arrondies × facteur de zone ; entrants ×1 ; secondes réelles inchangées |
| `POST /minutes-company/charge-call` | durée relue de l'appel stocké (comme #142), facteur selon l'appel stocké |
| Webhook du clavier navigateur | durée maximale = solde / N pour une destination internationale (`maxSecondsForBalance(solde, N)`) |
| Pré-contrôle (jeton, vérification de destination) | 402 `MINUTES_INSUFFICIENT_FOR_DESTINATION` avec `creditsPerMinute` et message « Insufficient balance for an international call: 1 minute = N credits. » (+ `messageFr`) si le solde ne couvre pas une minute internationale |
| Rappel de messagerie vocale, transfert d'appel | durée maximale = solde / N ; refus clair avec N |

Refus parlé du webhook (en/fr/es) : « Solde insuffisant pour un appel international : 1 minute = N crédits. » Un appel qui traverse le solde reste possible (solde négatif toléré comme aujourd'hui).

**Un seul point de résolution du coefficient** (`coefficientOf`, `creditCoefficient.js`) pour le débit, `charge-call`, le webhook, le pré-contrôle, le rappel, le transfert et la lecture Facturation : forfait (métadonnée → environnement → 1), et **sans forfait lisible (`limits` null) : l'environnement, sinon 1**.

**Aucun accès ni dépendance nouvelle par défaut** : à N = 1 (rien configuré), le pays de l'entreprise et les lignes ne sont **jamais** lus. La lecture du forfait, seule nécessaire pour savoir si la métadonnée existe, est réutilisée **30 s par société** (au plus une lecture), et seulement quand des appels sont à débiter. **Toute lecture impossible (forfait, lignes) retombe sur 1 crédit par minute, comme avant** : jamais de report ni d'interruption du débit normal (compromis assumé : un appel international compté pendant une panne de lecture est alors débité à 1).

**Messages d'insuffisance identiques en en / fr / es sur tous les canaux** (un seul texte par langue, `SPOKEN_REFUSALS.*.insufficient_minutes_international`) : refus parlé du webhook et du rappel (langue de la ligne), pré-contrôle (`message`, `messageFr`, `messageEs`), transfert (`message` en français, `messageEn`, `messageEs`), décision d'appel.

**Dépassement possible** : le solde peut passer sous zéro de quelques crédits (jusqu'à N − 1 par appel, davantage si plusieurs appels internationaux partent simultanément avec le même solde, ou si un appel est compté après coup) ; comme aujourd'hui pour le solde en minutes, aucun blocage rétroactif.

## Lecture pour l'écran Facturation

`GET /api/minutes-company/:companyId/credits` (JWT, titulaire de cette entreprise, lecture seule) → `credits` (solde), `includedMinutes`, `internationalCreditsPerMinute` (coefficient appliqué), `coefficientSource` (`plan` / `env` / `default`), `internationalMinutesEquivalent` (solde / coefficient, à titre d'information), `zone{companyCountry, euZone}`. `GET /:companyId` (existant) est inchangé : son « solde en minutes » est désormais un solde de crédits.

## Impact à communiquer

À coefficient 4, **un client qui appelle l'international consomme son forfait 4 fois plus vite** : 30 minutes incluses = 30 crédits = 7 minutes internationales entières. Les packs et achats à la minute existants créditent le même solde (1 minute achetée = 1 crédit). Les appels nationaux, UE et DOM-TOM ne changent pas.

## Limites connues / non couvert

- Le rappel de messagerie vocale reprend la même logique que le webhook (ligne du rappel, refus parlé en/fr/es) mais n'a pas de test dédié (le contrôleur n'est pas testable sans simulations lourdes) ; la durée maximale et le refus passent par `maxSecondsForBalance(…, N)` testé.
- Plafond « mou » : plusieurs appels simultanés lancés avec le même solde peuvent le dépasser ensemble (comme avant).
- Front (affichage du coefficient, écran Facturation) et `dash_calls` hors périmètre.

## Revue indépendante : règles ajoutées avant d'activer N > 1

- **Trace du webhook (B1)** : l'appel sortant du navigateur enregistre sa décision (ligne retenue, zone, facteur) dans `CallCreditDecision`, sous le `CallSid` reçu par le webhook (premier enregistrement gagnant, purge à 45 jours). Le débit (lecture du solde, `charge-call`) relit cette trace ; il ne reclasse que les appels sans trace (autres canaux). Plafond et débit utilisent ainsi la même zone. Hypothèse non vérifiée : le `sid` de l'appel stocké dans `calls` est celui du `CallSid` du webhook ; sinon le débit reclasse (comportement d'avant, jamais plus d'erreur que cela).
- **Entrant / interne (B2)** : seul un appel dont `direction` commence par `outbound` (outbound, outbound-api, outbound-dial) peut être facturé au coefficient. Direction absente, `incoming`, `inbound`, jambe de transfert : 1. Un appel dont la destination est une ligne de l'entreprise : 1.
- **Périmètre de « aucun accès supplémentaire à N = 1 » (C1)** : vrai pour les lignes (aucune lecture du pays ni des lignes à N = 1) ; le forfait, lui, est lu (cache 30 s) comme l'exige le plafond de durée.
- **Cache du forfait (C2)** : ni `null` ni erreur ne sont mémorisés, les lectures simultanées d'une société sont partagées, 500 sociétés au plus (la plus ancienne est évincée). **Sous-facturation assumée** : si le forfait ou les lignes sont illisibles pendant un appel international, il est débité 1 crédit la minute (jamais bloqué, jamais reporté).
- **Offre Accueil (C3)** : après la prise d'une ligne dans la réserve, le facteur et le plafond sont recalculés avec cette ligne ; s'il ne couvre plus le solde, la ligne est libérée et l'appel refusé.
- **Transfert (C4)** : le facteur est calculé avec la ligne qui a reçu l'appel (celle utilisée comme identifiant de l'appelant du transfert).
- **Code mort (C6)** : `planCreditCharging` ne renvoie plus de `deferred` (toujours vide) ; commentaire d'`escrowController` corrigé.

## Journal de consommation (revue indépendante)
À coefficient > 1, `GET /api/billing/consumption-journal` affiche pour chaque appel le facteur RÉELLEMENT débité (`debitsForCalls` : trace du webhook d'abord, sinon reclassement, avec la même règle que le débit ; entrant et appel interne : 1), tous canaux. À coefficient 1 : aucune lecture en plus, quantité historique. Forfait ou lignes illisibles : quantité historique.
**Non bloquant, listé** : le pré-contrôle `minutesShortfall` classe sur la première ligne (la ligne réellement utilisée n'est connue qu'au webhook) ; le plafond de durée côté `dash_calls` n'applique pas le coefficient (le débit, lui, le fait) tant que `dash_calls` n'est pas adapté ; NANP : +1 distingue États-Unis et Canada seulement, les autres territoires +1 (ex. +1 787) sont classés d'après leur indicatif régional connu.
