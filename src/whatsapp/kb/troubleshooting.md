---
id: troubleshooting
title: Troubleshooting guide - common problems, causes and fixes
product: platform
audience: all
summary: Symptom -> likely causes -> concrete steps, grounded in real HARX rules (sign-up, verification code, gig activation, limits, numbers, calls, billing).
sources: [v25_registration_backend/src/services/authService.js, v25_comporchestrator_front/src/components/ApprovalPublishing.tsx, v25_comporchestrator_back/src/controllers/phoneNumberController.js, v25_dash_calls_backend/src/controllers/calls.js, v25_callcenter_front/docs/PARCOURS_ET_TESTS.md]
verified: 2026-11-12
---
# Troubleshooting

## I cannot create my account
- "Password must be at least 8 characters with letters and numbers" -> choose a longer password containing letters and digits.
- "Email already registered" -> the email has an account: sign in or use password recovery. Different email only if it really is a different person.
- No verification email -> check spam/promotions, wait a minute, request a new code (a code lasts 10 minutes), make sure the email has no typo.
- "invalid or expired code. Please try again." -> the code is older than 10 minutes or mistyped: request a new one and use the latest.

## I cannot sign in
"Invalid email" / "Invalid password" -> check the address and password; "Account not verified" -> finish email verification first; forgot password -> use password recovery (code emailed). An invitation/magic link that expired -> ask the sender or request a new link.

## I cannot activate my gig
The activation screen lists the missing setup steps: telephony, upload contacts, REP onboarding, call script, session planning (knowledge base optional). Complete each one for THAT gig (a done step on another gig does not count). If all steps are done and activation is still refused, check the plan's active-gig limit (pause/archive another gig or change plan). If the gig seems complete but remains blocked, collect the exact message and escalate.

## "Plan limit" messages (gigs, REPs, operations, lines, seats)
Limits come from the plan: use get_my_account_overview to see the user's plan and quotas; the fix is to free a slot or upgrade. Nomad Solo: 1 line, 1 user, 1 active operation.

## I cannot buy a phone number
Check: subscription active, plan line limit (Solo = 1), country supported (France numbers via Twilio; +44 needs an approved regulatory bundle), payment succeeded ("Payment required" / "Payment / number mismatch" -> payment not confirmed: retry from the same window), provider errors ("Number not available" -> pick another; "Provider credit insufficient" / "Twilio Trial Limit Reached" -> platform side: escalate).

## Calls do not work
- Browser phone: allow the microphone, click "Take calls", use a supported browser. Outbound refused: subscription must be active/trialing, minutes balance above zero, destination allowed (default France +33 for Solo).
- REP "Call blocked": enrolled? trainings complete? inside a reserved slot for that gig?
- Balance at zero: top up minutes; AI actions need tokens.
- Recording/analysis missing: wait and refresh; analysis needs tokens.

## I see "403 / You do not have access to this company"
Wrong account, or the invitation is not accepted, or missing permission. Ask which email they logged in with; the owner can adjust permissions (topic roles-permissions).

## Payment or subscription problems
past_due/unpaid -> update the payment method from the billing portal; a webhook can be late: wait a few minutes then reload; a promotion code must be typed in the Stripe payment form; double charges, refunds and disputes -> escalate.

## Slow or blank page
Refresh, clear cache, try another browser/private window; pages are loaded as separate apps on harx.ai so a temporary load error can occur: reload once. If persistent, ask for the exact URL, browser and time, then escalate as a possible bug.
