# Dette de sécurité : routes serveur-à-serveur sans jeton de service

État au moment de l'écriture (branche `recette`, avant les PR #148 à #164). Ces routes sont appelées par `v25_dash_calls_backend` (et, pour `reconcile`, aussi par le front) **sans aucun jeton** ; leur donner une authentification casserait ces appelants. Elles restent donc ouvertes tant qu'un jeton de service n'est pas envoyé par `dash_calls`. Aucune n'accepte d'argent ni de crédit de la part de l'appelant (voir « Risque résiduel »).

| Route | Fichier | Appelants (lus, branches par défaut) | Risque résiduel |
|---|---|---|---|
| `GET /api/internal/companies/:companyId/minutes-balance` | `src/routes/internal.js` | `dash_calls` `src/controllers/calls.js:68` (portillon avant appel, ouvert si échec) | lecture du solde de minutes et de l'historique de crédits de toute société |
| `GET /api/internal/companies/:companyId/wallet-balance` | `src/routes/internal.js` | `dash_calls` `calls.js:92` | lecture du solde du portefeuille |
| `GET /api/internal/companies/:companyId/tokens-balance` | `src/routes/internal.js` | `dash_calls` `src/services/voiceMenuAi.js:60` | lecture du solde de jetons IA |
| `POST /api/escrow/reconcile/:companyId` | `src/routes/escrow.js` | `dash_calls` `calls.js:207, 3094`, `src/services/integrations/twilio.js:448` ; **front** `src/lib/walletBalanceSync.ts:130` (`fetch` nu) | rejoue l'état de la base (idempotent), mais déclenchable en boucle (charge) |
| `POST /api/escrow/call-analysis-complete`, `/call-analysis-help` | `src/routes/escrow.js` | `dash_calls` `calls.js:1945`, `3297` | émission de messages WebSocket forgés vers les clients de la société nommée |
| `POST /api/minutes-company/charge-call` | `src/routes/minutesCompany.js` | `dash_calls` `calls.js:1448`, `integrations/twilio.js:340` | durcie (#142) : le débit vient de l'appel stocké, jamais du corps |
| `POST /api/tokens-company/charge-usage` | `src/routes/tokensCompany.js` | `dash_calls` `voiceMenuAi.js:83` | #150 : jeton de service ou JWT acceptés ; un appelant sans identité reste accepté tant que `TOKENS_CHARGE_USAGE_ENFORCE_AUTH` n'est pas posée ; les quantités restent déclarées par l'appelant |

## Précédent à réutiliser
`POST /api/internal/call-ended` utilise déjà un jeton de service : JWT HS256 signé avec `JWT_SECRET`, charge utile `{ scope: 'call-ended', exp }` (`src/controllers/callEndedController.js`, émetteur `dash_calls` `src/services/callEndedNotifier.js`). Et `requireCompanyParam` (`src/middleware/companyScope.js`) accepte déjà un jeton de service portant `service` et le `companyId` pour lequel il agit.

## Plan proposé (3 étapes, réversibles)
1. **Orchestrateur, mode observation** : fonction commune `verifyServiceToken(header, { scope, companyId })` (HS256, `exp` obligatoire et court, `scope` exact, `companyId` égal à celui de la route/du corps quand la route en porte un). Brancher les 7 routes ci-dessus en **observation** : un jeton valide est accepté, son absence est journalisée (`[service-token] absent sur <route>`) sans refus. Portées : `balance-read`, `reconcile`, `call-analysis`, `charge-call`, `charge-usage`.
2. **dash_calls** : émettre ces jetons (durée 5 minutes, `scope` et `companyId`) sur chacun de ses appels listés (même mécanisme que `callEndedNotifier`). Côté **front**, remplacer le `fetch` nu de `walletBalanceSync.ts:130` par `authFetch` ; `reconcile` accepte alors un JWT utilisateur du propriétaire/membre de la société (`guardCompanyAccess`) **ou** un jeton de service.
3. **Application** : variable `SERVICE_TOKEN_ENFORCE=true` en recette puis en production après quelques jours sans journal « absent » ; sans jeton valide : 401 ; service de jetons mal configuré (pas de secret) : 503, jamais ouvert.
Autres durcissements à faire dans la foulée : `charge-usage` (quantités déclarées par l'appelant → les calculer côté serveur à partir de l'usage enregistré) ; WebSocket : voir #155.

## Hors de ce dépôt
Les étapes 2 (dash_calls, front) ne peuvent pas être faites ici. Aucune de ces PR n'a été écrite dans ces dépôts.
