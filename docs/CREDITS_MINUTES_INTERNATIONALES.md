# Crédit minute international = N crédits minute nationale

Recette uniquement à ce stade. Remplace le second solde / les packs internationaux (PR #143, non fusionnée) : **un seul solde de minutes** (`MinutesCompany`, packs et achats à la minute existants inchangés).

## Règle (décision du propriétaire)

- Un appel **international** débite **N crédits par minute** : minute entamée arrondie à la minute supérieure, **puis** multipliée par N (61 s à N=4 : 2 min × 4 = 8 crédits).
- Un appel **national, UE ou DOM-TOM** débite **1 crédit par minute**, comme aujourd'hui.
- Zone : voir « Classification ». Entrants : coefficient national (1) **sauf provenance internationale lisible** (choix documenté ci-dessous).
- Idempotence inchangée : une clé par appel (`sid`), débit atomique (`chargedCallSids`).

## Le coefficient N n'est pas écrit en dur

Ordre de lecture : **métadonnée Stripe `international_minute_credits` du produit du forfait**, sinon **variable d'environnement `INTERNATIONAL_MINUTE_CREDITS`**, sinon **1**. Borne : entier entre 1 et 100 ; valeur invalide (métadonnée ou variable) → **1 + avertissement** `[credits]` (une métadonnée invalide ne bascule pas sur la variable d'environnement : on ne devine pas l'intention).

**Déploiement sans changement** : sans métadonnée ni variable, N = 1 et **tout est strictement inchangé** (testé pour les 4 offres). On passe ensuite à la valeur voulue en configuration (par exemple `INTERNATIONAL_MINUTE_CREDITS=4`, ou la métadonnée sur le produit d'une offre). Le coefficient est relu à chaque comptage (pas de cache applicatif propre à cette fonction ; un changement d'environnement demande un redémarrage, un changement de métadonnée passe par la synchronisation des forfaits existante).

## Classification (réutilisée de la PR #143)

- Pays de l'entreprise = indicatif de sa **première ligne lisible** (même règle que `outboundPolicy`, lu même quand le titulaire a personnalisé ses pays activés).
- **Domestique** : pays de l'entreprise ; si l'entreprise est dans l'UE, les 27 pays de l'UE (`src/services/euCountries.js`, codes ISO, Royaume-Uni absent) ; régions françaises d'outre-mer **+262, +590, +594, +596 traitées comme la France**. Limite connue : Saint-Barthélemy (hors UE) et la partie française de Saint-Martin partagent +590 avec la Guadeloupe, indistinguables par l'indicatif.
- **International** : tout le reste (Royaume-Uni, Suisse, Norvège, États-Unis… ; entreprise hors UE appelant l'UE comprise).
- **+1** : États-Unis et Canada (un seul indicatif) sont domestiques entre eux, limite connue.
- **Entreprise sans ligne lisible** : zone inconnue, jamais supposée dans l'UE → **1 crédit** (comportement historique) + avertissement `pays de l'entreprise inconnu`.
- **Entrants** : classés sur la **provenance** (numéro appelant) : provenance internationale lisible (E.164, hors de la zone de l'entreprise) → N ; provenance **masquée, absente ou illisible → 1**. Choix : un entrant se juge sur le pays d'où il vient, comme un sortant sur le pays où il va ; sans provenance lisible on ne facture pas plus que le national.

## Où le coefficient s'applique

| Point | Effet |
| --- | --- |
| Lecture du solde (`syncMinutesFromCalls`) | crédits de chaque appel = minutes arrondies × facteur de zone ; secondes réelles inchangées |
| `POST /minutes-company/charge-call` | durée relue de l'appel stocké (comme #142), facteur selon l'appel stocké |
| Webhook du clavier navigateur | durée maximale = solde / N pour une destination internationale (`maxSecondsForBalance(solde, N)`) |
| Pré-contrôle (jeton, vérification de destination) | 402 `MINUTES_INSUFFICIENT_FOR_DESTINATION` avec `creditsPerMinute` et message « Insufficient balance for an international call: 1 minute = N credits. » (+ `messageFr`) si le solde ne couvre pas une minute internationale |
| Rappel de messagerie vocale, transfert d'appel | durée maximale = solde / N ; refus clair avec N |

Refus parlé du webhook (en/fr/es) : « Solde insuffisant pour un appel international : 1 minute = N crédits. » Un appel qui traverse le solde reste possible (solde négatif toléré comme aujourd'hui).

**Erreur de lecture** : forfait illisible pendant le comptage → les appels de type international sont **différés** (jamais débités à 1 à tort, repris à la lecture suivante), les autres sont débités ; si le pays est lui aussi illisible, le comptage est interrompu (mieux vaut retarder que mal débiter). `charge-call` ne débite rien si le forfait est illisible (la lecture du solde reprend l'appel). Pour décider d'un appel à venir, une lecture impossible donne 1 (jamais de blocage) ; le débit réel reclasse l'appel.

## Lecture pour l'écran Facturation

`GET /api/minutes-company/:companyId/credits` (JWT, titulaire de cette entreprise, lecture seule) → `credits` (solde), `includedMinutes`, `internationalCreditsPerMinute` (coefficient appliqué), `coefficientSource` (`plan` / `env` / `default`), `internationalMinutesEquivalent` (solde / coefficient, à titre d'information), `zone{companyCountry, euZone}`. `GET /:companyId` (existant) est inchangé : son « solde en minutes » est désormais un solde de crédits.

## Impact à communiquer

À coefficient 4, **un client qui appelle l'international consomme son forfait 4 fois plus vite** : 30 minutes incluses = 30 crédits = 7 minutes internationales entières. Les packs et achats à la minute existants créditent le même solde (1 minute achetée = 1 crédit). Les appels nationaux, UE et DOM-TOM ne changent pas.

## Limites connues / non couvert

- Le rappel de messagerie vocale reprend la même logique que le webhook mais n'a pas de test dédié (le contrôleur n'est pas testable sans simulations lourdes) ; la durée maximale et le refus passent par `maxSecondsForBalance(…, N)` testé.
- Plafond « mou » : plusieurs appels simultanés lancés avec le même solde peuvent le dépasser ensemble (comme avant).
- Front (affichage du coefficient, écran Facturation) et `dash_calls` hors périmètre.
