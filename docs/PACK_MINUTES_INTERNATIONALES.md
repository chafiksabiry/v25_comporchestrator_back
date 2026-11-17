# Minutes internationales (second solde séparé)

Recette uniquement à ce stade. Remplace l'approche « dépassement facturé à la minute » (abandonnée). Aucun montant, aucune taille de pack n'est écrit dans le code : packs depuis Stripe, tarif à la minute depuis la configuration.

## Règle (décision du propriétaire)

- S'applique aux **4 offres Call Centre** (Nomad Solo, Accueil, Full Scope, Multi-clients) **de la même manière**, sans métadonnée par offre. Les forfaits non Call Centre ne sont pas concernés.
- Un appel sortant **domestique** (pays de l'entreprise ; si l'entreprise est dans l'UE, les 27 pays de l'UE, régions françaises d'outre-mer comprises) utilise le solde normal : comportement actuel.
- Un appel sortant **international** (tout le reste) n'utilise **que** le solde de minutes internationales : plafonné à ce solde, débité de lui seul. Solde zéro : refus « pack de minutes internationales requis », jamais de débit du solde normal.
- Appels entrants et numéros surtaxés (toujours refusés) : inchangés.
- Le solde international est une collection distincte (`InternationalMinutesCompany`).
- **Deux façons de l'alimenter**, au choix du client : un **pack** (Stripe) ou l'**achat à la minute** au tarif international (configuration). Seul le tarif varie.

## Interrupteur global — `INTERNATIONAL_MINUTES_ENFORCED`

Variable d'environnement, **coupée par défaut** (valeurs actives : `true`, `1`, `yes`, `on` ; lue à chaque appel, pas de redéploiement de code, un redémarrage suffit).
- **Coupé** : comportement actuel strictement inchangé pour tout le monde (l'appel international consomme le solde unique). Les achats (pack, minutes internationales) fonctionnent et alimentent déjà le solde international, mais ce solde n'est ni exigé ni débité par les appels. Le comptage des appels ne touche pas au solde international.
- **Actif** : la règle ci-dessus s'applique aux 4 offres Call Centre.

### Bascule recommandée (à décider, rien n'est décidé ici)
1. Avant d'activer : créer au moins un pack Stripe ET/OU configurer le tarif à la minute internationale ; livrer l'écran d'achat côté front. Sans aucun des deux, `GET /balances` donne `packsAvailable:false`/`minuteRateCents:null` et le serveur journalise un avertissement : l'activer bloquerait les appels internationaux sans moyen d'acheter.
2. Options pour ne pas couper les clients au moment de la bascule : (a) un **crédit de départ** unique sur le solde international (par exemple d'après leurs minutes internationales récentes dans `calls`, ou un forfait fixe) ; (b) une **date d'activation** (par exemple prévenir les clients, puis activer l'interrupteur à date fixe ; une variable de date d'activation n'est pas implémentée) ; (c) activer d'abord en recette uniquement.
3. Juste avant d'activer : laisser la lecture des soldes compter les appels en attente (les appels sont comptés à la lecture du solde) : un appel passé avant la bascule mais compté après serait débité du solde international.
4. Après : suivre les refus `INTERNATIONAL_PACK_REQUIRED` (pré-contrôle) et les avertissements `[international]`.

## Configuration

| Où | Clé | Valeur | Rôle |
| --- | --- | --- | --- |
| Produit Stripe du **pack** | `pack_type` | `international_minutes` | identifie un pack |
| Produit Stripe du **pack** | `international_minutes` (ou `minutes`) | entier | minutes incluses |
| **Prix** Stripe du pack | prix ponctuel (`one_time`) actif | montant, devise (`currency_options` possibles) | prix du pack |
| Document `platformpricings` (`key: "default"`) | `internationalMinutesCustomRateCents` | nombre > 0 (centimes par minute) | tarif de l'achat à la minute ; **absent = achat à la minute indisponible** (aucune valeur par défaut) |

## Ce qui arrive aujourd'hui aux appels internationaux, par offre (vérifié dans le code)

Aucune logique de minutes ne dépend de l'offre : la destination doit être dans un pays **activé** par le titulaire (par défaut le pays de l'entreprise seul, déduit de sa première ligne ; réglage `outboundPrefixes`) et non surtaxée ; l'appel international consomme le **même solde unique** que le national (1 minute facturée = 1 minute décomptée, arrondi supérieur), sans tarif par destination ; solde nul : sortant refusé ; l'entrant n'est jamais refusé. **Ce PR ne change rien tant que l'interrupteur est coupé.**

## Interfaces

- Achat : `POST /api/payments/checkout/init`, `purpose: "international_minutes_purchase"`, `provider: "stripe"` ; soit `packId` (identifiant du prix Stripe ; contenu et prix relus de Stripe), soit `minutes` (entier > 0 ; montant = minutes × tarif de la configuration). Refus : 400 hors Stripe ou quantité invalide, 404 pack inconnu, 409 `international_pack_not_applicable` (forfait non Call Centre), 409 `international_rate_not_configured` (achat à la minute sans tarif). Le client n'impose ni montant ni durée. Crédit idempotent par paiement (clé `pack:<paiement>`), par webhook et par `confirm`.
- Tarifs : `GET /api/payments/checkout/config` → `pricing.internationalPacks[]`, `pricing.internationalMinutesCustomRateCents` (et `…Euros`), `null` si non configuré.
- Lecture : `GET /api/minutes-company/:companyId/balances` (JWT, titulaire de cette entreprise) → `national{minutes, includedMinutes}`, `international{applies, enforced, purchasable, packsAvailable, minuteRateCents, minutes, purchasedMinutes, consumedSeconds}`, `zone{companyCountry, euZone}`, `packs[]`. `applies` = interrupteur actif ET offre Call Centre ; `purchasable` = offre Call Centre (achat possible même interrupteur coupé) ; `packsAvailable` : `true` / `false` (aucun pack Stripe) / `null` (erreur de lecture Stripe, jamais confondue avec « aucun pack » ; ou offre non éligible).
- Refus : `{ success:false, code:"INTERNATIONAL_PACK_REQUIRED", zone:"international", balance, message (EN), messageFr }` ; refus parlé en/fr/es.

## Zone : règles et limites

- Pays = indicatif pays de la **première ligne lisible** de l'entreprise (lu même quand le titulaire a personnalisé ses pays activés). **Sans ligne lisible : pays inconnu, jamais supposé dans l'UE** → comportement historique, avertissement `[international] pays de l'entreprise inconnu`.
- **Régions françaises de l'UE** : +262, +590, +594, +596 traitées comme la France. Limite connue : Saint-Barthélemy (hors UE) et la partie française de Saint-Martin partagent +590 avec la Guadeloupe, indistinguables. Autres collectivités d'outre-mer (+687, +689, +681…) : internationales.
- **+1** : États-Unis et Canada domestiques entre eux (un seul indicatif ; les autres pays NANP aussi, limite connue).
- Liste UE : `src/services/euCountries.js` (27 codes ISO, Royaume-Uni absent).

## Limites connues

- Plafond « mou » : plusieurs appels internationaux simultanés lancés avec le même solde peuvent le dépasser ensemble (comme le solde normal).
- Erreur de lecture du forfait ou du second solde pendant le comptage : les appels de type international sont **différés** (jamais débités du solde normal), tous les autres sont débités normalement ; `charge-call` ne débite rien si le forfait est illisible (la lecture du solde reprend l'appel).
- Pas de remboursement ni de retrait de minutes internationales ; PayPal non proposé pour ces achats.
- Le tarif à la minute vient du document de configuration `platformpricings` : il n'a pas d'écran d'administration dans ce dépôt (à renseigner en base).
- Front (écran Facturation, achat) et `dash_calls` hors périmètre.
