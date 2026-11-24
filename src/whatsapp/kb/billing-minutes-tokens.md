---
id: billing-minutes-tokens
title: Billing rules - minutes, AI tokens, balances, payments and invoices
product: platform
audience: company
summary: How call minutes and AI tokens are counted and topped up, what happens at zero balance, how payments work, invoices and failed payments.
sources: [v25_callcenter_front/README.md, v25_comporchestrator_back/src/models/MinutesCompany.js, v25_comporchestrator_back/src/models/TokensCompany.js, v25_comporchestrator_back/src/routes/minutesCompany.js, v25_comporchestrator_back/src/routes/tokensCompany.js, v25_comporchestrator_back/src/routes/subscription.js, v25_comporchestrator_back/src/config/minutesPricing.js]
verified: 2026-11-12
---
# Minutes, AI tokens and payments

## Minutes
- Counting: every started minute is billed (rounded up per communication). Outbound counts from the moment the call is answered (ringing is free). Inbound counts the voice menu, queue wait and conversation. A transfer is a second communication, rounded separately.
- The company has a prepaid MINUTES balance: minutes included by the plan (credited each billing period) plus purchased packs. The balance can go below zero to show overconsumption. At a zero balance the call in progress ends and following calls are blocked (402 / "payment required" style messages).
- Top-up: buy a pack or a free quantity (Stripe payment window); the balance is credited when the payment is confirmed. Test calls never consume minutes.

## AI tokens
AI features (voicemail analysis, greeting suggestion, script generation, call analysis, AI assistants) consume prepaid AI TOKENS. Included tokens come from the plan; more can be bought. With too few tokens an AI action is refused with a payment-required message (HTTP 402) and a link to billing; some actions require a minimum balance (voicemail analysis: 3,000 tokens).

## Payments
- Subscription: Stripe (PayPal also exists as a provider for some purchases). Card payment happens in an embedded secure form; webhooks confirm payments, and a "confirm" call from the app is the safety net if the webhook is late.
- Failed subscription payment -> status past_due/unpaid; lines are suspended then released after a month of non-recovery (see telephony-onboarding-numbers).
- Invoices and payment methods are available in the Billing area of the orchestrator (list invoices, add/remove/default payment method, billing portal).
- REPs are paid for results: see topic reps-matching (wallet, payouts).

## What the assistant can and cannot do
It can read the balances of the linked company (get_my_account_overview) and explain rules. It cannot refund, credit minutes, change a card or cancel: refunds, disputes and billing corrections are escalated to human support.
