# Intégrations CRM, API publique et webhooks

Réservé aux produits qui incluent le groupe de fonctions **H** (Full Scope et Multi-clients). Recette uniquement.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `INTEGRATIONS_ENC_KEY` | **Obligatoire.** Clé de chiffrement des identifiants CRM et des secrets de webhook (32 octets : 64 caractères hexadécimaux ou base64). Sans elle, les routes d'écriture répondent 503 `integrations_disabled` et la reprise des tâches ne démarre pas. À générer : `openssl rand -hex 32`. Ne jamais la changer sans ré-enregistrer les identifiants. |
| `JWT_SECRET` | Déjà utilisé : signe/vérifie les jetons de service (`call-ended`, `center-data`). |
| `DASH_CALLS_API_URL` | Déjà utilisé : service des appels (lecture des appels/contacts, import). |
| `ZOHO_OAUTH_CLIENT_ID`, `ZOHO_OAUTH_CLIENT_SECRET`, `ZOHO_OAUTH_REDIRECT_URI`, `INTEGRATIONS_RETURN_URL` | Optionnelles. « Connexion en un clic » Zoho avec une application HARX : **désactivée tant qu'une de ces variables manque**. `ZOHO_OAUTH_REDIRECT_URI` = `<API>/api/integrations/oauth/zoho/callback`. |

## Connecteurs

Chaque centre n'a qu'une connexion. Les identifiants sont chiffrés (AES-256-GCM, liés au centre) et ne sont jamais renvoyés.

* **HubSpot** : jeton d'application privée.
* **Zoho CRM** : « Self Client » créé par le centre dans sa console Zoho (identifiant, secret, jeton de rafraîchissement, région).
* **Dynamics 365** : application Azure AD du locataire du centre (flux client credentials).

> **Les points d'accès des trois CRM sont écrits de mémoire et marqués « À VÉRIFIER » dans le code** : les sites officiels n'étaient pas joignables lors du développement. Ils n'ont été testés que contre un faux serveur. À valider sur un compte de test de chaque éditeur avant tout usage réel.

Fonctionnement : le service des appels signale chaque appel terminé (`POST /api/internal/call-ended`, jeton `call-ended`). Si la connexion est active et testée, l'appel est mis en file puis écrit dans le CRM (contact créé/mis à jour, puis appel). Reprises à 1 min, 5 min, 30 min, 2 h, 12 h, puis abandon (visible dans le journal, relançable). Jamais bloquant pour l'appel.

## API publique (lecture seule)

Base : `https://<orchestrateur>/api/public/v1`. Clé créée dans Paramétrage > Intégrations, **affichée une seule fois**, stockée hachée (SHA-256).

```
curl -H "Authorization: Bearer hx_live_…" "https://<orchestrateur>/api/public/v1/calls?limit=25"
```

* `GET /calls` : `id, direction, status, from, to, started_at, ended_at, duration_seconds, operation_id, agent_name`. Ni enregistrement ni transcription.
* `GET /contacts` : `id, first_name, last_name, email, phone, operation_id, created_at`.
* Paramètres : `limit` (1 à 100, 25 par défaut), `cursor` (valeur de `next_cursor`), `since` (date ISO, appels).
* Limite : 60 requêtes par minute et par clé (`429` + `Retry-After`). En-têtes `X-RateLimit-*`.
* Erreurs : `{ "error": { "code", "message" } }` (401 clé absente/révoquée, 403 forfait, 429, 502).

## Webhooks sortants

Événement `call.completed` (aussi `call.test` pour l'essai), corps JSON :

```
{ "id": "evt_<appel>", "type": "call.completed", "createdAt": "…", "companyId": "…",
  "data": { "call": { "id", "direction", "status", "from", "to", "startedAt", "endedAt", "durationSeconds", "operationId", "agentName" } } }
```

En-têtes : `X-Harx-Event`, `X-Harx-Delivery`, `X-Harx-Signature: t=<secondes>,v1=<hex>` avec `v1 = HMAC-SHA256(secret, "<t>.<corps brut>")`. Le secret (`whsec_…`) est montré une seule fois. Vérifiez la signature sur le **corps brut** et refusez un `t` de plus de 5 minutes. Répondez 2xx ; sinon reprises comme ci-dessus. HTTPS obligatoire, adresses internes refusées. Un même événement peut être livré plusieurs fois : dédoublonnez sur `id`.

```js
const [t, v1] = header.split(',').map((p) => p.split('=')[1]);
const ok = crypto.timingSafeEqual(Buffer.from(v1, 'hex'), crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest());
```

## Limites connues

* Limitation de débit en mémoire : par instance (une seule instance en recette).
* Import de contacts : écrit dans la collection des prospects avec les champs existants (`First_Name`, `Last_Name`, `Email_1`, `Phone`, `gigId`, `companyId`)  ; non vérifié : que le service des appels et le tableau de bord partagent la même base de prospects.
