# Notes rapides (post-it) — contrat d'API

Prendre des notes rapides dans l'application Téléphonie. Préfixe : `/api/notes`. Authentification : `Authorization: Bearer <jwt>` (même jeton que les autres routes).
La société est celle de l'appelant (service d'inscription, `callerAccess`) ; un agent employé par plusieurs sociétés choisit la sienne avec `?companyId=` (GET, DELETE) ou `companyId` dans le corps (POST, PATCH), refusée (403 `COMPANY_NOT_ALLOWED`) si ce n'est pas l'un de ses emplois.

## Règles de confidentialité
- **Privée par défaut** : un utilisateur ne lit, ne modifie et ne supprime que **ses** notes. Aucun rôle (propriétaire, responsable) n'élargit cette règle : les responsables ne lisent jamais une note privée d'un autre.
- Une note d'un autre utilisateur ou d'une autre société répond **404 `NOTE_NOT_FOUND`** (on ne révèle pas son existence).
- `visibility: 'company'` (lecture seule pour les membres de la société) n'est acceptée que si `NOTES_COMPANY_VISIBILITY_ENABLED=true` (valeur exacte). Par défaut : coupé → 403 `NOTE_COMPANY_VISIBILITY_DISABLED`. Indicateur coupé, une note « société » déjà écrite n'est plus lue que par son auteur.
- Aucune donnée de note n'est envoyée à une IA ; le contenu n'est jamais journalisé (les journaux portent seulement `[notes] <action> failed: <NomErreur>`).
- Suppression **définitive** (pas de corbeille) : une note peut contenir des données personnelles ; supprimer doit réellement effacer.

## Limites (constantes dans `src/services/notes.js`)
| Constante | Valeur |
|---|---|
| `MAX_TEXT_LENGTH` | 5000 caractères |
| `MAX_TITLE_LENGTH` | 120 caractères |
| `MAX_NOTES_PER_USER` | 500 notes par utilisateur et par société |
| `DEFAULT_PAGE_SIZE` / `MAX_PAGE_SIZE` | 20 / 50 |
| `MAX_QUERY_LENGTH` (recherche) | 100 caractères |
| `COLORS` | `yellow` (défaut), `pink`, `blue`, `green` |

## Note
```json
{ "id": "…", "companyId": "…", "ownerUserId": "…", "mine": true, "text": "…", "title": "", "color": "yellow",
  "pinned": false, "visibility": "private", "callId": null, "contactId": null, "contactPhone": null,
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601" }
```

## Routes
- `GET /api/notes?pinned=true|false&callId=&contactId=&contactPhone=&q=&page=1&limit=20`
  → `200 { success, notes: Note[], page, limit, total, hasMore }`. Tri : épinglées d'abord, puis modifiées le plus récemment. `q` : recherche littérale sans casse dans texte et titre. `contactPhone` est normalisé (`06 12…` → `+33612…`). Page hors limites : liste vide.
- `POST /api/notes` — corps : `text` (obligatoire), `title`, `color`, `pinned`, `visibility`, `callId`, `contactId`, `contactPhone`. → `201 { success, note }`.
- `PATCH /api/notes/:id` — mêmes champs, tous facultatifs, au moins un ; `null` efface `title`, `callId`, `contactId`, `contactPhone`. → `200 { success, note }`.
- `DELETE /api/notes/:id` → `200 { success: true }`.

`callId` : identifiant d'appel (`[A-Za-z0-9_-]{1,64}`, ex. SID), non vérifié (les appels vivent dans plusieurs collections). `contactId` : fiche de **la même société** (vérifié).
Champs inconnus ou non modifiables (`ownerUserId`, `createdAt`…) : 400 `NOTE_FIELD_UNKNOWN`.

## Erreurs
Forme : `{ success: false, error, message, code, … }` (`error` = `message`, comme les routes contacts / suivi).

| HTTP | `code` | Cas |
|---|---|---|
| 401 | `AUTH_REQUIRED` / (corps `error` seul) | jeton absent ou invalide |
| 403 | `NO_COMPANY` | utilisateur sans société |
| 403 | `COMPANY_NOT_ALLOWED` | `companyId` demandé hors de ses emplois |
| 403 | `NOTE_COMPANY_VISIBILITY_DISABLED` | `visibility: 'company'` sans l'indicateur |
| 503 | `COMPANY_LOOKUP_FAILED` / `COMPANY_LOOKUP_NOT_CONFIGURED` | service d'inscription indisponible : refus fermé |
| 400 | `NOTE_TEXT_REQUIRED`, `NOTE_TEXT_TOO_LONG`, `NOTE_TITLE_TOO_LONG`, `NOTE_TITLE_INVALID`, `NOTE_COLOR_INVALID`, `NOTE_PINNED_INVALID`, `NOTE_VISIBILITY_INVALID`, `NOTE_CALL_ID_INVALID`, `NOTE_CONTACT_ID_INVALID`, `NOTE_CONTACT_PHONE_INVALID`, `NOTE_FIELD_UNKNOWN`, `NOTE_NOTHING_TO_UPDATE`, `NOTE_ID_INVALID`, `NOTE_QUERY_INVALID` | validation |
| 400 | `NOTE_CONTACT_NOT_FOUND` | contact absent de la société |
| 404 | `NOTE_NOT_FOUND` | note inexistante, d'un autre utilisateur ou d'une autre société |
| 409 | `NOTES_QUOTA_EXCEEDED` (+ `limit: 500`) | quota atteint ; modifier/supprimer reste possible |
| 500 | `NOTES_READ_FAILED`, `NOTE_CREATE_FAILED`, `NOTE_UPDATE_FAILED`, `NOTE_DELETE_FAILED` | erreur base (sans contenu) |

## Suppression d'un compte ou d'une connexion
Aujourd'hui, ce dépôt **ne reçoit aucun événement** de suppression de compte ou de société (les comptes vivent dans `v25_registration_backend`) et n'a aucune purge de ce type : les notes d'un utilisateur ou d'une société supprimés **resteraient en base** (collection `notes`). Ce n'est pas câblé ici (hors périmètre) ; à traiter avec l'équipe du service d'inscription (appel service-à-service ou tâche de purge) avant la mise en production.
