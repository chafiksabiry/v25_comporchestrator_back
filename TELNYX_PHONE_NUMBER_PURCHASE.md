# Documentation - Achat de Numéros Telnyx

## Vue d'ensemble

Ce document décrit le processus complet d'achat de numéros de téléphone via Telnyx, incluant la gestion des requirements réglementaires, l'association aux entreprises, et la gestion des webhooks pour le suivi des changements de statut.

## Flow de Traitement

### Processus Global

Pour acheter un numéro de téléphone pour une zone de destination donnée, une entreprise doit suivre ce flux :

1. **Sélection de la zone de destination** : L'entreprise sélectionne un gig qui définit une zone de destination (code alpha2, ex: "US", "FR")

2. **Recherche de numéros disponibles** : Le système recherche les numéros locaux disponibles pour cette zone via l'API Telnyx
   - **Route Backend** : `GET /api/phone-numbers/search?countryCode={alpha2}`
   - **Frontend** : Appel à `phoneNumberService.searchPhoneNumbers(destinationZone, 'telnyx')`

3. **Vérification des requirements** : Pour certaines zones de destination, Telnyx exige des informations réglementaires
   - **Route Backend** : `GET /api/requirements/countries/{countryCode}/requirements`
   - **Frontend** : Appel à `requirementService.checkCountryRequirements(destinationZone)`
   
4. **Gestion des requirements** : 
   - Si des requirements existent, un groupe de requirements est créé ou récupéré pour l'entreprise
   - L'entreprise peut compléter ses requirements progressivement (le progrès est sauvegardé automatiquement)
   - **Routes Backend** :
     - `POST /api/requirement-groups` (création)
     - `GET /api/requirement-groups/companies/{companyId}/zones/{destinationZone}` (récupération)
     - `POST /api/requirements/groups/{groupId}/documents/{field}` (soumission de documents)
     - `POST /api/requirements/groups/{groupId}/values/{field}` (soumission de valeurs textuelles)
     - `GET /api/requirement-groups/{groupId}/status` (vérification du statut)
   - **Frontend** : Gestion via `requirementService` avec sauvegarde du groupId en cookie

5. **Achat du numéro** : Une fois que tous les requirements sont complétés (ou s'il n'y en a pas), l'entreprise peut acheter un numéro
   - **Route Backend** : `POST /api/phone-numbers/purchase`
   - **Frontend** : Appel à `phoneNumberService.purchasePhoneNumber()` avec le `requirementGroupId` (Telnyx ID)

6. **Mise à jour automatique via webhook** : Telnyx envoie des webhooks pour notifier les changements de statut de la commande
   - **Route Backend** : `POST /api/phone-numbers/webhooks/telnyx/number-order`
   - Le système met automatiquement à jour le statut du numéro (pending → active → error, etc.)

## Architecture du Système

### Modèles de Données

#### TelnyxRequirementGroup
```javascript
{
  telnyxId: String,           // ID du groupe chez Telnyx
  companyId: String,          // ID de l'entreprise
  destinationZone: String,    // Code pays (2 lettres, ex: "US", "FR")
  status: String,             // pending, active, rejected
  requirements: [{
    requirementId: String,     // ID du requirement Telnyx
    type: String,             // document, textual, address
    status: String,           // pending, completed
    submittedValueId: String, // ID du document/adresse ou valeur textuelle
    submittedAt: Date        // Date de soumission
  }]
}
```

#### PhoneNumber
```javascript
{
  phoneNumber: String,        // Numéro de téléphone
  telnyxId: String,          // ID Telnyx du numéro
  provider: String,          // "telnyx"
  orderId: String,           // ID de la commande Telnyx
  requirementGroupId: ObjectId, // Référence vers TelnyxRequirementGroup
  gigId: ObjectId,           // ID du gig associé
  companyId: ObjectId,       // ID de l'entreprise
  status: String,            // pending, active, error
  telnyxStatus: String,      // Statut Telnyx
  features: {
    voice: Boolean,
    sms: Boolean,
    mms: Boolean
  }
}
```

## Détails Techniques

### 1. Recherche de Numéros Disponibles

Le système recherche les numéros locaux disponibles pour une zone de destination donnée.

**Route Backend** : `GET /api/phone-numbers/search?countryCode={alpha2}`  
**Service Frontend** : `phoneNumberService.searchPhoneNumbers(destinationZone, 'telnyx')`

Le frontend appelle cette route lorsqu'un utilisateur sélectionne un gig avec une zone de destination spécifique.

### 2. Vérification des Requirements

Pour déterminer si une zone nécessite des informations réglementaires.

**Route Backend** : `GET /api/requirements/countries/{countryCode}/requirements`  
**Service Frontend** : `requirementService.checkCountryRequirements(destinationZone)`

Cette vérification est effectuée automatiquement lors de la sélection de Telnyx comme provider.

### 3. Création d'un Groupe de Requirements

**Route Backend** : `POST /api/requirement-groups`  
**Service Frontend** : `requirementService.getOrCreateGroup(companyId, destinationZone)`

Le système crée automatiquement un groupe de requirements si des requirements sont nécessaires.

```json
{
  "companyId": "company_123",
  "destinationZone": "US"
}
```

#### Types de Requirements Supportés
- **Document** : Fichiers PDF, images (pièces d'identité, certificats)
- **Textuel** : Informations textuelles (nom d'entreprise, numéro d'enregistrement)
- **Adresse** : Adresses physiques complètes

### 4. Soumission des Requirements

L'entreprise peut compléter ses requirements progressivement. Le progrès est sauvegardé à chaque soumission.

**Soumission de document** : `POST /api/requirements/groups/{groupId}/documents/{field}`  
**Soumission de valeur textuelle** : `POST /api/requirements/groups/{groupId}/values/{field}`  

**Service Frontend** : 
- `requirementService.submitDocument(groupId, field, file)`
- `requirementService.submitTextValue(groupId, field, value)`

Le frontend sauvegarde le `groupId` en cookie pour pouvoir reprendre plus tard sans perdre le progrès.

### 5. Vérification du Statut des Requirements

**Route Backend** : `GET /api/requirement-groups/{groupId}/status`  
**Service Frontend** : `requirementService.getDetailedGroupStatus(groupId)`

Retourne le pourcentage de complétion et le nombre de requirements restants.

### 6. Achat de Numéro

Une fois que tous les requirements sont complétés (ou s'il n'y en a pas), l'entreprise peut acheter un numéro.

**Route Backend** : `POST /api/phone-numbers/purchase`  
**Service Frontend** : `phoneNumberService.purchasePhoneNumber(data)`

Le système envoie la commande à Telnyx avec le `requirementGroupId` (Telnyx ID).

```json
{
  "phoneNumber": "+1234567890",
  "provider": "telnyx",
  "gigId": "gig_123",
  "companyId": "company_123",
  "requirementGroupId": "telnyx_group_id_456"
}
```

### 7. Réception du Webhook de Mise à Jour de Statut

**Route Backend** : `POST /api/phone-numbers/webhooks/telnyx/number-order`

Telnyx envoie automatiquement ce webhook lorsque le statut de la commande change. Le backend met à jour automatiquement le statut du numéro en base de données (pending → active, etc.).

## Gestion des Webhooks

### Configuration
Les webhooks Telnyx sont configurés pour recevoir les notifications de changement de statut de commande de numéros.

#### Endpoint Webhook
```
POST /api/phone-numbers/webhooks/telnyx/number-order
```

### Traitement des Webhooks
Ce webhook est utilisé pour recevoir les notifications de changement de statut des commandes de numéros Telnyx.

- **Déclencheur** : Telnyx envoie ce webhook lorsque le statut d'une commande de numéro change (pending → active, rejected, etc.)
- **Actions** :
  - Mise à jour du statut du numéro dans la base de données locale
  - Synchronisation des statuts depuis Telnyx vers notre système
  - Gestion automatique des erreurs de commande

### Configuration du Webhook dans Telnyx

Dans le dashboard Telnyx, le webhook doit être configuré avec :
- **URL** : `https://votre-domaine.com/api/phone-numbers/webhooks/telnyx/number-order`
- **Event Types** : `number-order.*` (tous les événements de commande de numéros)
- **Signature Verification** : Activée avec le secret configuré dans les variables d'environnement

## API Endpoints

### Recherche et Achat de Numéros

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/phone-numbers/search` | Rechercher des numéros disponibles (Telnyx) |
| GET | `/api/phone-numbers/search/twilio` | Rechercher des numéros Twilio |
| POST | `/api/phone-numbers/purchase` | Acheter un numéro Telnyx |
| POST | `/api/phone-numbers/purchase/twilio` | Acheter un numéro Twilio |
| GET | `/api/phone-numbers/gig/:gigId/check` | Vérifier si un gig a un numéro |
| GET | `/api/phone-numbers/` | Récupérer tous les numéros |

### Requirement Groups

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/requirement-groups` | Créer un nouveau groupe |
| GET | `/api/requirement-groups/:groupId` | Récupérer un groupe |
| GET | `/api/requirement-groups/companies/:companyId/zones/:destinationZone` | Groupe d'une entreprise |
| PATCH | `/api/requirement-groups/:groupId/requirements` | Mettre à jour requirements |
| GET | `/api/requirement-groups/company/:companyId/status` | Statut des requirements |
| GET | `/api/requirement-groups/:groupId/status` | Statut d'un groupe |

### Requirements (Soumission)

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| GET | `/api/requirements/countries/:countryCode/requirements` | Liste des requirements pour un pays |
| POST | `/api/requirements/groups/:groupId/documents/:field` | Soumettre un document |
| POST | `/api/requirements/groups/:groupId/values/:field` | Soumettre une valeur textuelle |
| POST | `/api/requirements/groups/:groupId/validate` | Valider les requirements |

### Webhooks

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | `/api/phone-numbers/webhooks/telnyx/number-order` | Recevoir les webhooks de changement de statut des commandes Telnyx |

## Gestion des Erreurs

### Erreurs Communes

#### Requirements
- **400** : Paramètres manquants ou invalides
- **404** : Groupe de requirements non trouvé
- **500** : Erreur de communication avec Telnyx

#### Achat de Numéros
- **400** : Numéro déjà enregistré
- **402** : Solde insuffisant
- **404** : Numéro non disponible

### Codes d'Erreur Telnyx
```javascript
switch (error.raw.code) {
  case 'number_already_registered':
    throw new Error('This number already exists in your account');
  case 'insufficient_funds':
    throw new Error('Insufficient balance to purchase this number');
  case 'number_not_available':
    throw new Error('This number is no longer available');
}
```

## Configuration

### Variables d'Environnement Requises
```bash
TELNYX_API_KEY=your_telnyx_api_key
TELNYX_WEBHOOK_SECRET=your_webhook_secret
TELNYX_CONNECTION_ID=your_connection_id
TELNYX_APPLICATION_ID=your_application_id
BASE_URL=your_base_url
```

### Configuration Telnyx
- **Base URL** : `https://api.telnyx.com/v2`
- **Webhook Secret** : Pour la vérification des signatures
- **Connection ID** : Pour la configuration des numéros

## Exemples d'Utilisation

### Scénario Complet : Achat d'un Numéro US

#### 1. L'utilisateur sélectionne un gig avec destination zone "US"

Le frontend (TelephonySetup.tsx) détecte automatiquement le code alpha2 "US".

#### 2. Le système vérifie les requirements

**Frontend** : 
```typescript
const response = await requirementService.checkCountryRequirements('US');
// Si response.hasRequirements = true, des requirements sont nécessaires
```

**Route appelée** : `GET /api/requirements/countries/US/requirements`

#### 3. Création/récupération du requirement group

**Frontend** :
```typescript
const { group, isNew } = await requirementService.getOrCreateGroup(companyId, 'US');
// Le groupId est sauvegardé en cookie pour persistance
```

**Routes appelées** :
- `GET /api/requirement-groups/companies/{companyId}/zones/US` (essai de récupération)
- `POST /api/requirement-groups` (création si nécessaire)

#### 4. Recherche de numéros disponibles

**Frontend** :
```typescript
const numbers = await phoneNumberService.searchPhoneNumbers('US', 'telnyx');
```

**Route appelée** : `GET /api/phone-numbers/search?countryCode=US`

#### 5. Soumission des requirements (exemple)

**Documents** :
```typescript
await requirementService.submitDocument(groupId, 'business_license', file);
```

**Valeurs textuelles** :
```typescript
await requirementService.submitTextValue(groupId, 'business_name', 'My Company');
```

**Routes appelées** :
- `POST /api/requirements/groups/{groupId}/documents/{field}`
- `POST /api/requirements/groups/{groupId}/values/{field}`

#### 6. Vérification du statut

**Frontend** :
```typescript
const status = await requirementService.getDetailedGroupStatus(groupId);
// Retourne { isComplete: true, completionPercentage: 100, ... }
```

**Route appelée** : `GET /api/requirement-groups/{groupId}/status`

#### 7. Achat du numéro

**Frontend** :
```typescript
await phoneNumberService.purchasePhoneNumber({
  phoneNumber: '+1234567890',
  provider: 'telnyx',
  gigId: 'gig_123',
  companyId: 'company_123',
  requirementGroupId: 'telnyx_group_id_456'
});
```

**Route appelée** : `POST /api/phone-numbers/purchase`

#### 8. Réception du webhook de mise à jour

**Webhook** : Telnyx envoie une notification à `POST /api/phone-numbers/webhooks/telnyx/number-order`

Le backend met automatiquement à jour le statut du numéro en base de données.

## Monitoring et Logs

### Logs Importants
- `📝 Creating Telnyx requirement group for {countryCode}`
- `✅ Created Telnyx requirement group: {id}`
- `📨 Received Telnyx webhook: {eventType}`
- `✅ Updated phone number {phoneNumber} status to: {status}`

### Métriques à Surveiller
- Nombre de requirement groups créés par jour
- Taux de succès des achats de numéros
- Temps de traitement des webhooks
- Erreurs de communication avec Telnyx

## Bonnes Pratiques

1. **Validation** : Toujours valider les paramètres avant les appels API
2. **Gestion d'erreurs** : Implémenter une gestion robuste des erreurs Telnyx
3. **Webhooks** : Vérifier les signatures pour la sécurité
4. **Synchronisation** : Maintenir la cohérence entre Telnyx et la base locale
5. **Logs** : Logger tous les événements importants pour le debugging
6. **Retry** : Implémenter des mécanismes de retry pour les appels API

## Dépannage

### Problèmes Courants

#### Requirements non synchronisés
- Vérifier la connectivité avec l'API Telnyx
- Contrôler les logs d'erreur
- Valider les formats de données

#### Webhooks non reçus
- Vérifier la configuration du webhook secret
- Contrôler l'URL du webhook dans Telnyx
- Vérifier les logs de signature

#### Numéros non activés
- Vérifier le statut des requirements
- Contrôler les erreurs de commande
- Valider la configuration des fonctionnalités
