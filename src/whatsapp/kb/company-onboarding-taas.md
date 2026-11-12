---
id: company-onboarding-taas
title: Company onboarding (TAAS) - 4 phases, 13 steps
product: taas
audience: company
summary: The real onboarding path of a company in the orchestrator: phases, steps, prerequisites, what is disabled, call-center variant.
sources: [v25_comporchestrator_front/src/components/CompanyOnboarding.tsx, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-12
---
# Company onboarding in the HARX Orchestrator

A first-time visit shows a quick tour ("Ready to orchestrate your operations?": Company Onboarding, Gigs & Matching, Training & Knowledge Base) that can be skipped. The onboarding wizard then guides 4 phases. Progress is saved per company (you can leave and resume: "Leave and resume later"); a completed step can be reopened with "Review step".

## Phase 1 - Company Account Setup & Identity
1. *Create Company Profile*: legal and commercial details, key contacts, terms agreement (company profile wizard).
2. *KYC / KYB Verification*: identity verification (Stripe Identity or Sumsub). In the current code this step is shown but disabled (not yet available), so it does not block progress.

## Phase 2 - Operational Setup (required: steps 3, 4, 5)
3. *Create Gigs*: define multi-channel gigs and requirements (see topic gigs).
4. *Telephony Setup*: phone numbers, call tracking and dialer configuration (see topic telephony-numbers).
5. *Upload Contacts*: import contacts for multi-channel engagement (see topic leads-crm-deals).
6. *Reporting Setup*: KPIs and reporting preferences (shown but disabled for now).

## Phase 3 - REPS Engagement (required: steps 7, 8, 9, 10)
7. *Knowledge Base*: training materials and FAQs the reps will use (improves answers; NOT required to activate a gig).
8. *E-learning*: training, validation and contract acceptance for reps (REP onboarding).
9. *Call Script*: define the script and conversation flows (script generator).
10. *Session Planning*: schedule call slots and prioritize leads (see topic schedules-attendance-slots).

## Phase 4 - Activation (steps 11, 12, 13)
11. *Subscription Plan*: choose a plan (see topic subscription-plans-limits).
12. *Gig Activation*: launch the multi-channel operation (approval and publishing).
13. *MATCH HARX REPS*: connect with qualified REPs based on the gig requirements (see topic reps-matching).

You move to the next phase when all required steps of the current phase are done. The step guide pop-ups explain each step before and during it.

## Call-center variant
Call-center companies use the same wizard with scope changes: step 13 (MATCH HARX REPS) is hidden, step 3 is called "Create Project" ("Enter the project title and destination zone"), and onboarding is considered at phase 2 as soon as the company profile (step 1) is done.
