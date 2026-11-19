---
id: telephony-offers
title: HARX Telephony offers (Nomad Solo, Accueil / Secrétariat, Full Scope, Multi-clients)
product: telephony
audience: company
summary: The four Telephony offers, what each includes (lines, seats, active operations, feature groups) and what is announced vs available.
sources: [v25_callcenter_front/src/domain/plans.ts, v25_callcenter_front/docs/lancement/08-offre-secretariat.md, v25_callcenter_front/docs/PARCOURS_ET_TESTS.md, v25_callcenter_front/README.md]
verified: 2026-11-12
---
# HARX Telephony offers

Telephony is a separate product from TAAS (no marketplace, no agent matching): small call centers, secretariats and solo professionals. Prices and monthly included minutes/tokens are NOT in the code (they live in the Stripe catalogue): use get_subscription_plans. Every offer includes one phone line; AI is included as access and its usage is charged per token from a prepaid balance. HARX reps network is an optional add-on (not purchasable yet).

## Nomad Solo
"Your phone number anywhere in the world, without roaming or international calls." One person only: this line is yours. Calls in and out in the browser, installable on mobile and computer (PWA); one number and your call journal; voicemail with an AI-suggested greeting and messages in your journal. Limits: 1 line, 1 seat (inviting someone is refused), 1 active operation. French numbers only.

## Accueil / Secrétariat
"Welcome, answer and call back for your company." Greeting message, voicemail and callbacks; several secretaries with their schedule and absence requests (2 secretary seats included for the line; the owner and managers do not count); messaging, internal agenda (export .ics) and video-meeting links; basic workflows from templates (4 templates validated by a person). 1 line included (extra lines are charged as licences), 1 active operation at a time. Note: "callbacks" means tasks to do by hand: the product does not call back by itself. There is no calendar sync with Google/Outlook: .ics export and e-mail with .ics attached.

## Company Full Scope In & Out
"The telephony of all your departments: sales, customer relations, collections." Unlimited inbound and outbound activities, access adapted to each collaborator (owner, manager, collaborator), steering/dashboards, AI quality analysis and Academy (training), CRM and API integrations, assisted onboarding. Announced "coming soon": card visible but not yet open for sign-up.

## Contact Centre Multi-clients
"For a call center that works for several clients": operations, numbers and reports per client; agents shared between clients, training, coaching and planning; client portal with your branding and read access; API for CRMs (HubSpot, Zoho, Dynamics). Announced "coming soon".

## Feature groups (A-N)
A Foundation (account, roles, invitations, basic dashboard); B Telephony (web softphone, numbers, inbound/outbound, queues, routing, recording); C Leads and campaigns (contact lists, dialer, scripts, consent proof); D Planning and attendance (work ranges per queue, coverage, schedule compliance, absences); E Quality and AI (transcription, call evaluation, coaching); F Knowledge and training; G Steering (standard/advanced indicators, exports); H Integrations (CRM, API, webhooks, e-mail, chat); I Multi-client (BPO); J Compliance and security (consent, recording retention, GDPR, audit); K Services (assisted onboarding, priority support); M Messaging and agenda; N Workflows. Plans unlock groups: Solo A,B,E,J; Accueil A,B,C,D,E,J,M,N; Full Scope adds F,G,H,K; Multi-clients adds I.

## Active operations
You can create as many operations as you want; the plan limits how many are ACTIVE at once (Solo: 1, Accueil: 1, Full Scope and Multi-clients: unlimited). Message when refused: the plan allows N active operation(s) at once: pause or archive one, or change plan.
