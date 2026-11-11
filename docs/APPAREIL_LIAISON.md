# Liaison d'appareil (QR / code court)

Permet à l'application Call Centre installable (origine autonome, sans session partagée avec le portail) d'obtenir une session depuis un portail déjà connecté.

## Contrat

### `POST /api/device-link` (JWT `Authorization: Bearer ...`)
Réponse `201` : `{ "code": "K7M2QX9R", "expiresAt": "2026-11-02T10:05:00.000Z" }`.
Code de 8 caractères (alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, sans 0/O/1/I/L), tiré avec `crypto.randomInt`, valable 5 minutes. `401` sans JWT valide.

### `POST /api/device-link/redeem` (PUBLIC)
Corps : `{ "code": "k7m2-qx9r" }` (casse, espaces et tirets ignorés).
- `200` : `{ "token": "<JWT>", "userId": "...", "companyId": "..." | null }`
- `400` : `{ "code": "INVALID_LINK", "message": "Code invalide ou expiré." }` (inconnu, expiré, déjà utilisé : non distingués)
- `429` : `{ "code": "RATE_LIMITED", ... }` + en-tête `Retry-After` (10 tentatives/minute/IP).

## Choix de sécurité
- Seul le hash SHA-256 du code est stocké (collection `device_links`), jamais le code.
- Usage unique : `findOneAndDelete` atomique (aussi vérifié sur `expiresAt`, car la purge TTL Mongo peut traîner jusqu'à ~60 s).
- Index TTL Mongo sur `expiresAt` (`expireAfterSeconds: 0`).
- Au plus 5 codes actifs par utilisateur ; les plus anciens sont supprimés.
- **Le jeton Bearer de l'appelant est stocké en clair dans la ligne** pendant au plus 5 minutes : c'est ce qui permet de restituer une session identique à celle du portail. Il disparaît à l'échange ou à l'expiration. Conséquence : l'appareil reçoit le même JWT, donc sa durée de vie restante est celle du JWT d'origine.
- Aucune journalisation du code ni du jeton ; les erreurs n'en contiennent pas.
- Limitation de débit en mémoire par IP (entrée la plus à droite de `X-Forwarded-For`, ajoutée par le proxy), 10/min.

## Limites
- Le limiteur est en mémoire : par instance, remis à zéro au redémarrage (suffisant avec une seule instance).
- Entropie : 31^8 (~8,5e11) combinaisons, 5 min de validité, 10 essais/min/IP.
- CORS : `index.js` reflète toute origine (`Access-Control-Allow-Origin: <Origin>`, credentials, `POST`, `Authorization` et `Content-Type` autorisés), donc `https://harx26callcenter-recette.netlify.app` peut appeler `redeem`. Il n'existe pas de liste blanche.
