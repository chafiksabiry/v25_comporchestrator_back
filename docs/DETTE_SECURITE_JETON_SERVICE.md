# Dette de sécurité : routes serveur-à-serveur encore sans jeton de service

État vérifié dans `origin/recette` (après #148, #150, #152, #153, #166 et les PR fermant `reconcile`, `call-analysis-*` et le WebSocket).

## Déjà traité (ne plus considérer comme dette)
| Sujet | État dans `recette` |
|---|---|
| `POST /api/escrow/reconcile/:companyId`, `/call-analysis-help`, `/call-analysis-complete` | exigent un jeton de service (portées `escrow-reconcile` / `call-analysis-notify`, `src/middleware/serviceToken.js`) **ou** un utilisateur de la société (`userOrService`, `src/routes/escrow.js:35-37`) |
| WebSocket `/escrow-updates` | jeton utilisateur obligatoire en sous-protocole `bearer`, diffusion filtrée par société / fiche agent (#153, #166) |
| `POST /api/tokens-company/charge-usage` | accepte la clé de service `x-service-key` (`TOKENS_SERVICE_KEY`) ou un JWT utilisateur ; `dash_calls` envoie ces jetons et la clé (dash_calls#34) ; `walletBalanceSync` du front passe par `authFetch` (front#62) |
| `POST /api/minutes-company/charge-call` | durcie (#142) : le débit vient de l'appel stocké (société, durée, test exclu), jamais du corps |

## Reste réellement ouvert
| Route | Fichier | Appelant | Risque résiduel |
|---|---|---|---|
| `GET /api/internal/companies/:companyId/minutes-balance` | `src/routes/internal.js:15` (`getMinutesInternal`) | `dash_calls` portillon avant appel, **sans jeton**, ouvert si échec | lecture du solde de minutes et de l'historique de crédits de toute société |
| `GET /api/internal/companies/:companyId/wallet-balance` | `internal.js:19` | `dash_calls`, sans jeton | lecture du solde du portefeuille |
| `GET /api/internal/companies/:companyId/tokens-balance` | `internal.js:22` | `dash_calls` (`voiceMenuAi`), sans jeton | lecture du solde de jetons IA |
| `POST /api/minutes-company/charge-call` | `src/routes/minutesCompany.js:13` | `dash_calls` | pas d'authentification ; risque borné par #142 (idempotent, durée et société relues en base), mais déclenchable en boucle |
| `POST /api/tokens-company/charge-usage` | `src/routes/tokensCompany.js:17` | `dash_calls` | **un appelant sans identité reste accepté tant que `TOKENS_CHARGE_USAGE_ENFORCE_AUTH` n'est pas activée** ; les quantités restent déclarées par l'appelant |

## À activer (configuration, aucun code)
1. Poser `TOKENS_SERVICE_KEY` (même valeur côté `dash_calls`) puis `TOKENS_CHARGE_USAGE_ENFORCE_AUTH=true` en recette, vérifier qu'aucun refus 401 n'apparaît dans les journaux de `dash_calls`, puis en production.

## Plan pour les 4 routes restantes (étapes réversibles)
Réutiliser `verifyServiceToken` (JWT HS256, `scope`, `exp` obligatoire, sans `userId`) et `userOrService` :
1. **Observation** : nouvelles portées `balance-read` (3 routes `internal`) et `charge-call` ; accepter un jeton valide, journaliser son absence (`[service-token] absent sur <route>`) sans refuser.
2. **`dash_calls`** émet ces jetons (5 minutes, portée, `companyId`) sur `calls.js` (portillon minutes et portefeuille), `voiceMenuAi.js` (jetons), `calls.js` et `integrations/twilio.js` (`charge-call`), comme pour `reconcile`.
3. **Application** : `SERVICE_TOKEN_ENFORCE=true` en recette puis en production après quelques jours sans journal « absent » ; sans jeton valide : 401 ; secret absent : 503, jamais ouvert. Dans le même temps, `charge-usage` : calculer les quantités côté serveur plutôt que de les prendre au corps.
Risque à garder en tête : le portillon de `dash_calls` laisse passer l'appel si la lecture échoue : activer l'étape 3 sans l'étape 2 désactiverait en silence le contrôle du solde (c'est déjà arrivé avec #147/#151).
