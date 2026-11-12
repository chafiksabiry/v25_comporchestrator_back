---
id: subscription-plans-limits
title: Subscription plans, limits, statuses and upgrades
product: platform
audience: all
summary: How plans and limits work (quotas come from the live Stripe catalogue), subscription statuses, plan change, launch codes. Never quote prices from memory.
sources: [v25_comporchestrator_back/src/models/SubscriptionPlan.js, v25_comporchestrator_back/src/models/Subscription.js, v25_comporchestrator_back/src/routes/subscription.js, v25_comporchestrator_front/src/lib/planMetadata.ts, v25_comporchestrator_front/src/components/Subscription.tsx, v25_callcenter_front/docs/PARCOURS_ET_TESTS.md]
verified: 2026-11-12
---
# Subscription plans and limits

## Where plan data comes from
Prices and limits are NOT fixed in the code: they come from the Stripe product catalogue (name, price, currency, features and product metadata) and are synchronised into the HARX plans. ALWAYS use get_subscription_plans for names, prices and limits, and get_my_account_overview for the user's own plan. If a value is missing say it is not published.

## Quotas a plan can define (Stripe product metadata)
- ACTIVE GIGS: how many gigs can be active at once.
- ACTIVE REPS: how many REPs can be active.
- COMMUNICATION MINUTES Included: minutes credited per billing period.
- AI TOKEN (Million): AI tokens credited (e.g. 1 = 1,000,000 tokens).
- ACTIVE LOCAL NUMBER (Included): phone numbers included.
Included minutes and tokens are credited once per billing period (idempotent); they add to the prepaid balance (paid packs are bought separately).

## TAAS company plans
The company application's step "Subscription Plan" ("Select Your Plan") lists the published plans (for example STARTER, then higher tiers such as GROWTH/RUNNER and SCALE/SCALER - names come from the catalogue). Buttons: Subscribe, Change plan, Current plan; payment is a secure Stripe form ("Initializing Stripe...", "Finalizing your subscription...", then "Subscription active"). A failure shows "Subscription confirmation failed". There are also plans for REPs (REP subscription) and call-center tiers.

## HARX Telephony plans
Four offers (Nomad Solo, Accueil / Secrétariat, Company Full Scope In & Out, Contact Centre Multi-clients) identified in Stripe by metadata harx_product=callcenter and a tier (nomad_solo, accueil, full_scope, multi_clients). Full Scope and Multi-clients are announced as "coming soon" in the app (card visible, no sign-up path yet). See topic telephony-offers.

## Subscription statuses
active, trialing, past_due (payment failed), unpaid, incomplete, incomplete_expired, canceled. A subscription flagged "cancel at period end" stays usable until the period ends. trialing counts as usable in the Telephony app.

## Changing or cancelling
Plan changes are done from the Subscription page ("Change plan"). Billing details, invoices and payment methods are managed through the billing portal/invoices pages of the orchestrator. The agent cannot change plans: guide the user, or escalate billing disputes.

## Promotion / launch codes
A promotion code can reduce the subscription price. The Stripe payment form contains a "promotion code" field: the customer must TYPE the code there (the page does not apply it automatically). Codes are created in Stripe; if a code is refused the form says so. Do not promise a code or a discount you cannot see in the catalogue - escalate if the user says a code should work.

## Common limit situations
- Cannot activate more gigs / add REPs: plan limit reached -> upgrade or free a slot.
- Telephony: Nomad Solo allows 1 line and 1 user only; "passez à un forfait supérieur" style messages mean the plan's line/seat limit is reached.
