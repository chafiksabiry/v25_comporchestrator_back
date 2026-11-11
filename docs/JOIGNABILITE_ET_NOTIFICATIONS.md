# Joignabilité du titulaire : renvoi vers le mobile et notifications push

Produit Nomad Solo (le titulaire est son propre agent), utilisable aussi par les autres paliers. Recette uniquement.

## Chemin d'un appel entrant sur la ligne d'un centre

1. Twilio appelle `POST /api/phone-numbers/webhooks/twilio/inbound-call`. La ligne est retrouvée par son numéro, ce qui donne le centre.
2. Les navigateurs « disponibles » de ce centre (`voicePresenceService`, en mémoire) sont lus. Un navigateur est disponible tant qu'il envoie un signal de présence (toutes les 20 s) : sans signal pendant 90 s il n'est plus appelé.
3. Décision (`decideInboundRoute`) :
   * un navigateur présent : il sonne (`<Dial><Client>`, délai du centre, 30 s par défaut) ; si personne ne décroche et que le renvoi est actif, le mobile sonne ensuite ; sinon répondeur ;
   * aucun navigateur, renvoi actif : le mobile sonne directement (`<Dial><Number>`, identifiant d'appelant = numéro de la ligne), puis répondeur ;
   * aucun navigateur, pas de renvoi : répondeur (message d'accueil + enregistrement) ou, s'il est désactivé, message de repli puis raccrochage.
4. L'appel est consigné (`inbound_calls`) avec `route` (où il a d'abord sonné), `mobileTried` et `answeredOn` (`browser` ou `mobile`) ; le statut reste `answered` / `missed` / `abandoned` / `voicemail` / `no_agent`, donc les statistiques d'accueil ne changent pas. Un appel décroché sur le mobile est inscrit au journal d'appels du centre par le serveur.
5. Sans navigateur présent, une notification push est envoyée aux appareils abonnés du titulaire ; un message laissé sur le répondeur déclenche aussi une notification.

## Pourquoi « l'appel entrant ne parvient pas au navigateur »

Cause prouvée par le code : le délai de présence était de 45 s alors que le navigateur envoie son signal avec un minuteur de 20 s. Un onglet en arrière-plan voit ses minuteurs ralentis par le navigateur (jusqu'à un signal par minute) : la présence expirait, l'appel tombait sur « aucun conseiller disponible » (journal serveur : *aucun conseiller disponible pour l'entreprise de la ligne …*) alors que l'application était ouverte. Corrections : délai porté à 90 s côté serveur, et signal renvoyé immédiatement par l'application au retour au premier plan et au retour du réseau.

Autres causes possibles, **non corrigeables par le code** et visibles dans le même journal (la liste `présents : [...]` indique les centres présents) : application fermée ou téléphone en veille (c'est le cas d'usage du renvoi mobile et des notifications), interrupteur « prendre les appels » désactivé, présence dans un autre centre, redémarrage du serveur (la présence est en mémoire : elle revient au prochain signal, moins de 20 s), plusieurs instances du serveur (la présence n'est pas partagée entre instances).

## Renvoi vers le mobile

* Réglage du titulaire, par centre : `GET/PUT /api/reach/settings` (`forwardEnabled`, `mobileNumber` au format international, `mobileRingSeconds` de 10 à 60, 25 par défaut).
* **Le numéro n'est pas vérifié par SMS** : le titulaire en est seul responsable, et l'interface le dit. Un numéro identique à la ligne est ignoré (boucle).
* Limites connues : si le répondeur du mobile décroche, Twilio considère l'appel comme pris (pas de filtrage « tapez 1 pour accepter ») ; l'appelant voit le numéro de la ligne chez le titulaire, pas son propre numéro ; la minute du mobile est facturée par l'opérateur. Les autorisations géographiques d'appels sortants de Twilio limitent les pays joignables.

## Notifications push (Web Push, VAPID)

Une notification **réveille** l'utilisateur ; elle ne peut pas décrocher l'appel Twilio. Il touche la notification, l'application s'ouvre, et s'il ne le fait pas, son mobile sonne si le renvoi est activé.

Routes (toutes authentifiées, titulaire seulement) sous `/api/reach` : `GET /push/public-key`, `GET /push/status?endpoint=`, `POST /push/subscribe`, `POST /push/unsubscribe`, `POST /push/test`. Les abonnements sont stockés par utilisateur (`push_subscriptions`) ; les 404/410 du service de notification les suppriment. Seuls les services de notification des navigateurs (FCM, Mozilla, Apple, Windows) sont acceptés comme point d'arrivée.

### Générer les clés et les poser (par le dirigeant)

1. Sur un poste quelconque : `npx web-push generate-vapid-keys`. Deux valeurs s'affichent : clé publique et clé privée. **Ne les collez jamais dans le code ni dans un message.**
2. Dans le tableau de bord Railway du service orchestrateur (environnement de recette), ajoutez trois variables :

| Variable | Valeur |
| --- | --- |
| `VAPID_PUBLIC_KEY` | la clé publique générée |
| `VAPID_PRIVATE_KEY` | la clé privée générée (secret) |
| `VAPID_SUBJECT` | `mailto:` suivi d'une adresse de contact, par exemple `mailto:technique@harx.ai` (ou une URL `https://`) |

3. Redéployez le service. Tant qu'une des trois variables manque, la fonction est désactivée : l'interface affiche « Notifications indisponibles pour le moment » et rien n'est envoyé.
4. Ne changez pas les clés une fois des appareils abonnés : tous les abonnements deviendraient invalides et chacun devrait se réabonner.

### Téléphones

* Android (Chrome) : fonctionne dans le navigateur.
* iPhone / iPad : Web Push exige que l'application soit **installée sur l'écran d'accueil** (iOS 16.4 ou plus récent).
