# Minutes d'appel hors forfait (offre Multi-clients)

Recette uniquement à ce stade. Aucun montant n'est écrit dans le code : tout vient des **métadonnées du produit Stripe**.

## Décision du propriétaire

Multi-clients : 99,99 €/mois, 1 numéro inclus, 30 min d'appels entrants **et** sortants, 50 000 jetons IA ; numéro supplémentaire 14,99 €/mois ; au-delà des minutes incluses : minute **nationale 0,15 €**, minute **internationale 0,63 €**.
Accueil et Full Scope : mêmes 30 minutes, mais comportement inchangé au-delà (sortant bloqué au solde nul, packs prépayés).

## Métadonnées du produit Stripe (à créer sur le produit Multi-clients)

| Clé | Valeur de la décision | Rôle |
| --- | --- | --- |
| `overage_national_cents` | `15` | prix d'une minute nationale hors forfait, en centimes |
| `overage_international_cents` | `63` | prix d'une minute internationale hors forfait, en centimes |
| `overage_cap_cents` | (absente) | facultatif : plafond de dépassement par période de facturation, en centimes |

- Lues comme les autres quotas (`extractStripeProductLimits`, recopiées dans `SubscriptionPlan.metadata` par `planMetadataSync` / webhook `product.updated`).
- Le dépassement n'est actif que si **les deux tarifs** sont présents ET que le palier est `multi_clients` (alias `multi_pays` compris). Sinon : comportement actuel, inchangé. Autres paliers et forfaits non Call Centre : jamais concernés, même si les clés existent sur leur produit.

## Spécification retenue (décisions par défaut)

1. **Classification.** Sortant : pays de la destination = pays de l'entreprise → NATIONAL, sinon INTERNATIONAL. « Pays » = indicatif pays, comme `outboundPolicy` (pays de l'entreprise = indicatif de sa première ligne ; sans ligne lisible, premier préfixe par défaut de la politique sortante, `+33`). Limite connue : `+1` regroupe États-Unis et Canada (comptés nationaux entre eux). Numéros surtaxés : toujours refusés, inchangé.
2. **Entrants.** Jamais refusés. Classés selon la **provenance** (`from`) quand elle est lisible (E.164, indicatif connu) : même indicatif que l'entreprise → national, sinon international ; provenance absente ou masquée → **national** (`basis: "default"` dans l'enregistrement).
3. **Sortant au solde nul.** Plus coupé : l'appel passe, durée maximale = maximum Twilio (4 h), ou, si un plafond existe, solde + minutes que le plafond restant paie à ce tarif. Plafond atteint et solde nul → refus comme aujourd'hui (`MINUTES_INSUFFICIENT_FOR_DESTINATION` / refus parlé). S'applique au clavier navigateur (webhook), au pré-contrôle (jeton, vérification de destination), au rappel de messagerie vocale et au transfert d'appel.
4. **Comptage.** Toute minute entamée est comptée en entier (arrondi supérieur, comme l'existant). Pour une entreprise concernée, un appel ne débite que les **minutes entières encore au solde** ; le reste est enregistré dans `MinutesCompany.overageCalls` (par appel : période, classe, minutes incluses / hors forfait, tarif et plafond du moment, horodatage). Débit, enregistrement et clé d'idempotence (`chargedCallSids`) sont écrits **dans une seule opération atomique** conditionnée à la lecture du solde (relecture et nouvel essai en cas de débit concurrent) : idempotent par appel, solde jamais négatif, un dépassement n'est jamais absorbé par l'octroi du mois suivant. Appels traités dans l'ordre chronologique.
5. **Période.** Rattachée à la période de l'abonnement au moment du comptage (même clé que l'octroi des minutes : abonnement + début de période). Un appel compté après le renouvellement (comptage différé) tombe dans la période suivante.
6. **Facturation.** Pour chaque période close (`periodEnd` passé) : une ligne de facture Stripe (invoice item) « Minutes nationales hors forfait » et une « Minutes internationales hors forfait » sur le client Stripe de l'entreprise, devise du forfait.
   - Webhook `invoice.created` d'un renouvellement (`subscription_cycle`, brouillon) : les lignes sont ajoutées **à cette facture**.
   - Tâche horaire (`billAllClosedPeriods`) : rattrape un événement manqué ; la ligne part alors en attente sur la **facture suivante**.
   - Idempotence : appels facturés marqués (`invoiceItemId`) ; clé `overage:<entreprise>:<période>:<classe>:<empreinte du lot d'appels>` utilisée comme clé d'idempotence Stripe **et** métadonnée relue avant toute création (la clé Stripe expire après 24 h). Des appels tardifs de la même période produisent une ligne distincte, sans refacturer les premiers.
   - Échec Stripe : journalisé (`[overage]`), jamais bloquant pour les appels ; repris à la passe suivante.
7. **Plafond** (`overage_cap_cents`) : appliqué au montant facturé (national d'abord, puis international, du plus ancien au plus récent) et à la durée accordée aux nouveaux appels. Plafond « mou » : plusieurs appels simultanés lancés juste avant le plafond peuvent le dépasser ; le montant facturé, lui, ne le dépasse jamais.
8. **Lecture** : `GET /api/minutes-company/:companyId/overage` (JWT, titulaire de cette entreprise uniquement, lecture seule) :
   `applicable`, `includedMinutes`, `includedRemaining`, `period{start,end}`, `currency`, `overage{national{minutes,unitCents,cents}, international{…}, estimatedCents, capCents, capReached}`. Autre forfait : `applicable: false`.

## Sécurité : `POST /api/minutes-company/charge-call`

Route service à service **non authentifiée** (existante). Pour une entreprise avec dépassement, un montant facturable en dépend : le corps n'est plus cru. L'appel doit exister dans la collection `calls` pour cette entreprise ; durée, sens et numéros sont ceux de ce document. Forfaits sans dépassement : comportement inchangé.

## À configurer en recette

- Webhook Stripe : abonner l'endpoint existant à l'événement **`invoice.created`** (sinon seule la tâche horaire facture, avec un mois de décalage).
- Ajouter les trois métadonnées ci-dessus au produit Multi-clients (puis laisser `planMetadataSync` les recopier, ou attendre `product.updated`).

## Hors périmètre / limites connues

- Le front (écran Facturation) et `dash_calls`. `GET /api/minutes-company/:companyId` renvoie toujours `limitReached = (minutes ≤ 0)` : pour Multi-clients l'écran doit s'appuyer sur `applicable` / `capReached` du nouvel endpoint.
- Comptage différé : les appels ne sont comptés qu'à la lecture du solde, au `charge-call`, ou avant la facturation (`billCompany` relance le comptage).
- `overageCalls` grandit avec le nombre d'appels en dépassement (comme `chargedCallSids`) ; pas d'élagage des lignes facturées dans cette version.
- Balayage horaire : requête `$elemMatch` sans index dédié sur les portefeuilles.
