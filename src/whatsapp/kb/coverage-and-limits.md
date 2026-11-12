---
id: coverage-and-limits
title: Knowledge coverage, known gaps and how this knowledge base is maintained
product: platform
audience: all
summary: What areas are deeply documented, what is thin or unconfirmed (treat with care), and how the knowledge base is regenerated.
sources: [v25_comporchestrator_back/scripts/buildKnowledgeBase.mjs]
verified: 2026-11-12
---
# Coverage and limits of this knowledge base

Documented from the real code (verified): sign-up/login/password rules, company onboarding phases, gig statuses and activation prerequisites, plan/limit mechanism, Telephony offers and number purchase rules, billing of minutes/tokens, planning, attendance KPIs, schedule requests, leads import, call QA, REP journey, roles and permissions catalogue, API routes, error messages, and the real screen texts of the company, REP and Telephony applications (generated topics).

Thin or NOT confirmed (do not guess; say so and escalate): exact prices and monthly included quotas (use the live plan tool), KYC/KYB details, reporting setup (disabled in the app), CRM integrations other than Zoho, payout delays and fees, legal/tax questions, anything about third-party services' own behaviour (Stripe, Twilio, Zoho), features announced as "coming soon" (TAAS company "publish a gig" landing entry, Full Scope, Multi-clients).

Maintenance: run `node scripts/buildKnowledgeBase.mjs <folder with the v25_* repositories>` to regenerate routes, permissions, error messages, model states and screen texts; run it with `--check-sources` to detect handwritten topics whose source files moved or disappeared; update the handwritten topics and their `verified` date when a feature changes.
