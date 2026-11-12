---
id: gigs
title: GIGs - creation, statuses, activation prerequisites and limits
product: taas
audience: company
summary: What a GIG is, its fields, statuses (to_activate/active/inactive/archived), the setup steps required before activation and the active-gig limit.
sources: [v25_gigsmanualcreation_backend/src/models/gigModel.ts, v25_comporchestrator_front/src/components/ApprovalPublishing.tsx, v25_comporchestrator_front/src/components/ActiveGigLimitModal.tsx, v25_callcenter_front/src/harx/gigs/components/gigsaicreation/lib/guidance.ts, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-12
---
# GIGs

A GIG is a mission a company publishes for HARX REPs: the work to do, required skills and seniority, schedule/availability, commission, and the leads to call.

## Creating a gig
- Created from the company application (step "Create Gigs") either manually or with AI assistance (AI assistants exist for basic information, schedule, commission, leads, skills, team and documentation).
- Main fields: title/description, category (examples offered: Call Center, Inbound Sales, Outbound Sales, Customer Service, Technical Support, Lead Generation, Appointment Setting, Customer Retention, Billing Support, Collections, Multilingual Support...), destination zone (country/zone), seniority level (Call Center, Agent Senior, Agent, Agent Junior, Supervisor), time zone and weekly availability schedule, commission (including a commission per call), required skills (technical, professional, soft), languages, lead types (hot, warm, cold) and team structure.
- In HARX Telephony / call-center mode a gig is shown as a "project" with just a title and a destination zone.

## Statuses
to_activate (created, not yet live), active, inactive, archived. A gig becomes `active` when its activation step is performed.

## What must be done before a gig can be activated
The activation screen blocks activation and shows "This gig cannot be activated until the following steps are completed" / "Setup incomplete (N step(s) remaining)" until these setup steps are done for that gig:
1. Telephony (a phone number configured),
2. Upload contacts (leads imported for the gig),
3. REP onboarding (e-learning/training for reps),
4. Call script,
5. Session planning (slots).
The Knowledge base step is recommended but optional. Bulk activation also refuses gigs with incomplete setup ("Complete all setup steps for the selected gigs before activating").

## Limits
The number of active gigs and active REPs allowed comes from the subscription plan ("ACTIVE GIGS", "ACTIVE REPS" limits). Reaching the limit opens an "active gig limit" dialog; pause or archive another gig, or change plan (topic subscription-plans-limits). On the planning grid, the plan also caps the number of active REPs ("The <plan> plan allows N active REP on the planning grid").

## Pausing and archiving
Gigs can be paused (inactive) and archived; deletion permissions are separate permissions for team members (topic roles-permissions).
