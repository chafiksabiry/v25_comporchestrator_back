# Pack de minutes internationales (second solde séparé)

Recette uniquement à ce stade. Remplace l'approche « dépassement facturé à la minute » (abandonnée, code retiré). Aucun montant, aucune taille de pack, aucune offre n'est écrit dans le code : tout vient de Stripe.

## Règle

- Un appel sortant **domestique** (pays de l'entreprise ; si l'entreprise est dans l'UE, les 27 pays de l'UE) utilise le solde normal : comportement actuel.
- Un appel sortant **international** (tout le reste, Royaume-Uni, Suisse, Norvège, États-Unis… ; entreprise hors UE appelant l'UE comprise) n'utilise **que** le solde de minutes internationales : plafonné à ce solde, débité de lui seul. Solde zéro : refus « pack de minutes internationales requis », jamais de débit du solde normal.
- Les appels entrants et les numéros surtaxés (toujours refusés) ne changent pas.
- Le second solde est une collection distincte (`InternationalMinutesCompany`), alimentée uniquement par l'achat d'un pack.

## Configuration Stripe (rien à déployer pour activer)

| Où | Clé | Valeur | Rôle |
| --- | --- | --- | --- |
| Produit de l'**offre** | `international_pack` | `true` (ou `1`, `yes`, `required`) | l'offre est concernée par la règle ci-dessus |
| Produit du **pack** | `pack_type` | `international_minutes` | identifie un pack |
| Produit du **pack** | `international_minutes` (ou `minutes`) | entier, ex. nombre de minutes incluses | contenu du pack |
| **Prix** du pack | prix ponctuel (`one_time`) actif | montant et devise Stripe (`currency_options` pour d'autres devises) | prix |

Les packs et le prix sont relus de Stripe (jamais du client). Sans la métadonnée `international_pack` sur le produit de l'offre, l'offre est **strictement inchangée**.

## Ce qui arrive aujourd'hui aux appels internationaux, par offre (vérifié dans le code)

Aucune logique de minutes ne dépend de l'offre (Nomad Solo, Accueil, Full Scope, Multi-clients) : pour toutes,
- la destination doit être dans un pays **activé** par le titulaire (par défaut : le pays de l'entreprise seul, déduit de sa première ligne ; réglage `outboundPrefixes`) et ne pas être surtaxée ;
- l'appel international, une fois le pays activé, consomme le **même solde unique** que l'appel national (1 minute facturée = 1 minute décomptée, arrondi supérieur), sans tarif par destination ;
- solde nul : sortant refusé (`MINUTES_INSUFFICIENT_FOR_DESTINATION` / refus parlé), l'entrant n'est jamais refusé.

## Ce que ça change

Uniquement pour une offre dont le produit Stripe porte `international_pack` : le point 2 de « Règle ». Pour toutes les autres : rien (tests de non-régression). Points d'entrée sortants couverts : webhook du clavier navigateur, pré-contrôle (jeton et vérification de destination, `402 INTERNATIONAL_PACK_REQUIRED`), rappel de messagerie vocale, transfert d'appel. Débit : lecture du solde et `POST /charge-call`.

## Interfaces

- Achat : `POST /api/payments/checkout/init` avec `purpose: "international_minutes_purchase"`, `provider: "stripe"`, `packId` (identifiant du prix Stripe). Refus : 404 pack inconnu, 409 `international_pack_not_applicable` (offre non concernée), 400 hors Stripe. Crédit idempotent par paiement (clé `pack:<paiement>`), par webhook et par `confirm`.
- Packs disponibles : `GET /api/payments/checkout/config` → `pricing.internationalPacks` (liste vide si aucun pack).
- Lecture : `GET /api/minutes-company/:companyId/balances` (JWT, titulaire de cette entreprise) → `national{minutes, includedMinutes}`, `international{applies, minutes, purchasedMinutes, consumedSeconds}`, `zone{companyCountry, euZone}`, `packs[]`.
- Refus : `{ success:false, code:"INTERNATIONAL_PACK_REQUIRED", zone:"international", balance, message (EN), messageFr }` ; refus parlé en en/fr/es.

## Interprétation de la zone (à confirmer par le propriétaire)

Pays = indicatif pays (comme `outboundPolicy`). `+1` regroupe États-Unis et Canada (domestiques entre eux). Les territoires d'outre-mer (+262 La Réunion/Mayotte, +590, +594, +596) ont leur propre code ISO et sont donc **hors zone** (internationaux), y compris pour une entreprise française : à décider. Liste UE : `src/services/euCountries.js` (27 codes ISO, Royaume-Uni absent).

## Limites connues

- Plafond « mou » : plusieurs appels internationaux simultanés lancés avec le même solde peuvent le dépasser ensemble (comme le solde normal).
- Appels comptés à la lecture du solde : un appel passé avant l'activation de la métadonnée et compté après serait débité du solde international (qui peut passer sous zéro, compensé à l'achat suivant).
- Pas de remboursement / retrait de minutes internationales. Front (écran Facturation, achat) et `dash_calls` hors périmètre.
