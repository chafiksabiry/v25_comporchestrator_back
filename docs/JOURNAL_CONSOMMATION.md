# Journal de consommation (minutes et jetons IA)

Permet au **titulaire du compte** de suivre ce qui a été octroyé, rechargé et consommé, en minutes d'appel et en jetons IA.
**Lecture seule** : le journal est reconstruit à chaque lecture à partir des données existantes. Il n'écrit rien et ne touche aucun solde
(aucun appel à un débit, un octroi ni une synchronisation). Recette uniquement.

## API

Les deux routes exigent un jeton (`authenticate`) puis le rôle **titulaire** de la société (`callerAccess`, `role === 'owner'`).
La société est celle du titulaire : un `companyId` éventuellement passé dans la requête est ignoré.

| Route | Rôle |
|---|---|
| `GET /api/billing/consumption-journal` | Liste paginée + résumé (JSON) |
| `GET /api/billing/consumption-journal/export.csv` | Même contenu, mêmes filtres, sans pagination (CSV) |

Paramètres : `type` (**obligatoire**, `minutes` ou `tokens`), `from`, `to` (date `YYYY-MM-DD` ou ISO ; `to` en date seule = fin de journée UTC,
bornes incluses), `nature` (une ou plusieurs valeurs séparées par des virgules), `page` (défaut 1), `limit` (défaut 50, plafond 200 ; ignorés par l'export).

Réponse `200` :

```json
{ "success": true, "data": {
  "type": "minutes", "page": 1, "limit": 50, "total": 8, "totalPages": 1,
  "items": [ { "id": "call:CA1", "type": "minutes", "date": "2026-10-10T09:00:00.000Z", "nature": "consommation",
               "quantity": -2, "balanceAfter": 98, "coefficient": null, "zone": null,
               "reference": { "callSid": "CA1", "direction": "outbound", "counterpart": "•••••••••78", "durationSeconds": 62, "billedMinutes": 2 },
               "source": "calls", "reconstructed": true, "quantityApproximate": false } ],
  "summary": { "granted": 240, "recharged": 80, "consumed": 6, "adjusted": 0, "expired": 0,
               "currentBalance": 100, "unexplained": -214, "orphanDebitedCalls": 1, "from": null, "to": null } } }
```

- Tri : plus récent d'abord ; les lignes sans date en dernier.
- `nature` : `octroi_forfait | recharge | consommation | ajustement | expiration`. `ajustement` et `expiration` n'existent pas dans le dépôt
  aujourd'hui : acceptés par le filtre, jamais produits.
- `quantity` : positive (crédit) ou négative (débit) ; `null` quand elle est inconnue (`quantityApproximate: true`).
- `reference` selon la source : appel (`callSid`, `direction`, `counterpart` masqué, `durationSeconds`, `billedMinutes`), achat (`paymentId`, `purpose`,
  `provider`, `providerRef`, `amountCents`, `currency`, `pack`), usage de jetons (`usageId`, `tool`, `gigId`, `provider`, `model`, `estimated`, `inputTokens`,
  `outputTokens`), octroi (`planName`, `grantKey`).
- `coefficient` et `zone` (`domestic | international | unknown`) : **champs réservés, toujours `null` aujourd'hui** (voir « Écriture au moment du débit »).
- `reconstructed: true` : ligne déduite d'une autre source que sa propre ligne datée (voir le tableau ci-dessous).
- **Résumé** : totaux sur la période `from`–`to` ; le filtre `nature` ne les modifie pas (la liste, elle, est filtrée). `consumed` et `expired` sont positifs.
  Jetons : `unattributedPlanGrant` ; minutes : `orphanDebitedCalls`.
- **Solde après opération** (`balanceAfter`) : calculé en remontant depuis le solde actuel (ligne la plus récente = solde actuel ; chaque ligne précédente =
  solde de la suivante − quantité de la suivante). Il ne dépend ni de la page ni des filtres. Une quantité inconnue interrompt la chaîne (`null` avant elle),
  une ligne sans date n'a pas de solde.
- **`unexplained`** = solde actuel − somme de toutes les lignes du journal (solde d'ouverture, ou mouvements sans trace : crédits manuels, etc.). Il n'est
  jamais absorbé en silence. `null` si une quantité est inconnue.

Erreurs (corps `{ success: false, code, message }`) : `400 invalid_type | invalid_date | invalid_range | invalid_nature | invalid_pagination`,
`401 unauthorized`, `403 forbidden` (agent, responsable ou membre non titulaire), `404 no_company`, `500 server_error`, `503 unavailable` (annuaire des sociétés
indisponible : on refuse, on ne devine jamais). Le rôle est vérifié **avant** les paramètres : un non-titulaire n'apprend rien de la validation.

**CSV** : UTF-8 avec BOM, séparateur virgule, fins de ligne CRLF, `Cache-Control: no-store`, `Content-Disposition: attachment`. Les nombres sortent tels quels ;
toute cellule texte dont le premier caractère significatif est `=`, `+`, `-`, `@`, tabulation ou retour chariot (après d'éventuels espaces) est préfixée d'une
apostrophe (le nom d'outil d'un usage de jetons vient d'un service tiers non authentifié : il est traité comme non fiable). Au plus 20 000 lignes ; au-delà,
export tronqué et en-tête `X-Journal-Truncated: true`.

## Vie privée

Pas de numéro de téléphone en clair, ni dans le JSON ni dans le CSV : la contrepartie (appelé en sortant, appelant en entrant) est réduite à ses **deux derniers
chiffres** (`•••••••••78`). Un identifiant de client navigateur (`client:…`), un numéro trop court ou un sens inconnu donnent `null`. Le numéro de la société
n'est jamais exposé. Le `providerRef` d'un achat (identifiant de session de paiement) est exposé au seul titulaire, pour retrouver la facture.

## D'où vient chaque ligne, et ce qui est reconstructible

| Nature | Minutes | Jetons |
|---|---|---|
| Octroi du forfait | `MinutesCompany.credits[]` (`kind: plan`, date réelle). **Attention** : la quantité de ces lignes est l'allocation *courante* du forfait au moment où `backfillPlanCredits` les a écrites. Période créditée (`planGrantKeys`) sans ligne datée : ligne `reconstructed`, quantité inconnue. | `TokensCompany.planGrantKeys` : date lue dans la clé (début de période) ; **quantité inconnue** (seul le cumul `planTokensGranted` est stocké), sauf s'il n'y a qu'une période. Reste non attribuable : `unattributedPlanGrant`. |
| Recharge / achat | `CompanyPayment` (`minutes_purchase`, ou moitié minutes d'un `bundle_purchase` marquée créditée), statut `succeeded`, date `fulfilledAt`. `fulfillMinutesPurchase` ne pousse **pas** de ligne dans `credits[]` : les achats ne sont tracés que par le paiement. `credits[].kind = recharge` (route `buy-minutes` retirée) est lu aussi, sans doublon. | `CompanyPayment` (`tokens_purchase` ou moitié jetons d'un pack). `buyTokens` (`POST /tokens-company/buy-tokens`) crédite **sans paiement ni trace** : non reconstructible. |
| Consommation | Appels de `calls` dont le `sid` est dans `chargedCallSids`, hors appels de test ; minutes = `ceil(durée/60)` (même règle que les débits). **Date = date de l'appel**, pas celle du débit (non stockée). | `TokensUsageLedger` (date réelle, `usageId`, outil, gig, fournisseur, modèle). |
| Ajustement, expiration | Aucun mécanisme dans le dépôt. | Idem. |

**Non reconstructible** (rien n'est inventé, rien n'est réécrit) : date réelle du débit d'un appel ; appel débité dont le document `calls` a disparu
(compté dans `orphanDebitedCalls`) ; appel débité dont la durée stockée a changé depuis ; quantité par période des octrois de jetons ; crédits manuels ou
administrateur sans trace ; achats via `buy-tokens` ; crédit d'un achat pour lequel `fulfilledAt` n'a pas été écrit (crash entre le crédit et l'écriture) ; débit de
jetons dont l'écriture du registre a échoué (erreur avalée par `chargeUsage`). Tous ces cas se retrouvent dans `unexplained`.

## Écriture au moment du débit (prévue, non câblée)

Le coefficient « minute internationale » n'est pas encore fusionné : **aucune fonction de débit n'est modifiée par cette PR**. Quand il le sera, le point d'accroche est
unique : chaque débit (`chargeCallMinutes`, `syncMinutesFromCalls`, `chargeCall`) pourrait inscrire, dans le même `findOneAndUpdate` atomique que le `$inc`, une ligne
de registre `{ at, sid, minutes, seconds, coefficient, zone }` ; le journal la lirait en priorité, avec `coefficient` et `zone` renseignés, et ne reconstruirait
depuis `calls` que les appels sans ligne. Le contrat d'API ne change pas (champs déjà présents). Même principe pour les octrois de jetons et les achats
(`fulfill*`).

## Limites connues

- Calcul à la volée sur tout l'historique de la société à chaque lecture (une lecture de `calls` filtrée par société, durée > 0, hors tests). Acceptable aujourd'hui ;
  à matérialiser ou indexer si une société dépasse quelques dizaines de milliers d'appels.
- Les champs des documents `calls` (`direction`, `from`, `to`, `startTime`, `createdAt`) sont ceux que ce dépôt lit ou écrit ; le schéma exact écrit par
  dash_calls n'a pas pu être vérifié (autre dépôt).
- Le solde lu est celui du portefeuille tel quel : le journal ne déclenche ni octroi du mois ni synchronisation des appels (ce sont des écritures). Un appel terminé mais
  pas encore débité n'apparaît donc pas, et le solde non plus n'en tient pas compte : les deux restent cohérents.
