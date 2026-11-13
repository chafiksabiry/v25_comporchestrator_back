---
id: telephony-onboarding-numbers
title: Telephony setup, buying a phone number, test call, voicemail and reception
product: telephony
audience: company
summary: Telephony onboarding steps, phone-number purchase rules and errors (France/Twilio, regulatory bundle, one line for Solo), test call, receiving calls in the browser, voicemail.
sources: [v25_callcenter_front/README.md, v25_callcenter_front/docs/PARCOURS_ET_TESTS.md, v25_comporchestrator_back/src/controllers/phoneNumberController.js, v25_comporchestrator_back/src/services/phoneLineBillingService.js, v25_comporchestrator_back/src/config/env.js, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-12
---
# Telephony setup and phone numbers

## The Telephony onboarding path (about 10 minutes)
Company and documents (KYB, SIREN checked) -> model (inbound customer service / outbound sales / internal support) -> team (email addresses) -> plan (card) and first top-up of the prepaid balance -> French number (bought if needed) -> queue and script pre-filled from the model -> test call. For Nomad Solo the path is shorter: offer (payment), identity, number, test call, then the "Mon poste" (My desk) screen. A stopwatch is shown and each step has a time budget. Subscription AND minutes are needed to continue ("an active subscription, minutes and tokens are needed to continue").

## Buying a number
- Number search is by country; France is always served by Twilio and returned numbers are French local numbers. A UK regulatory bundle is required for +44. If the provider requires a regulatory bundle the error is "Regulatory Bundle Required" (the company's compliance documents must be approved first: see requirements/documents in the orchestrator).
- Each purchase goes through a Stripe payment window, then the line is billed monthly. Errors you may meet: "Payment required", "Payment / number mismatch", "Number purchase failed", "Number not available" (NUMBER_NOT_AVAILABLE, "Ce numéro n'est pas disponible."), "Provider credit insufficient", "Twilio Trial Limit Reached". If a purchase fails after payment, the message mentions a refund; if nothing is explained, escalate.
- Plan limits: Nomad Solo allows ONE line (a second purchase is refused with the French message "L'offre <plan> inclut 1 numéro local actif. Passez à une offre supérieure pour en ajouter."). Other plans include 1 line and charge extra lines as licences.
- Line billing rules (PAY-19): a first line of a TAAS company can start with a trial period; after the trial the monthly price is charged; if payment fails the line is suspended; a line suspended for one month without recovery is released. The Telephony call-center product has no free line trial. The line status shows billing status and a countdown to termination when payment is overdue.
- Terminating a number releases it (permission "telephony.terminate" for team members).

## Test call
After buying a number the "test call" rings the user's own phone from the line; the user presses 1 to validate the line. Test calls do not consume minutes.

## Receiving and making calls
- Inbound calls ring the people available in the browser ("Calls enabled" / "Take calls", microphone must be allowed); if nobody is present the call is forwarded to the owner's mobile, then to voicemail.
- Nomad Solo has an outbound keypad in the portal; outbound calls need an active or trial subscription and a minutes balance above zero; by default only French (+33) destinations.
- Voicemail: ring delay adjustable (5 to 120 seconds), caller message up to 120 seconds, voicemail screen with follow-up status (new, to call back, called back, closed) and notes. AI analysis of a message (transcription, summary, intent, urgency, callback number) needs at least 3,000 AI tokens in the balance; otherwise the message waits ("waiting for tokens").
- Greeting message: proposed by AI, editable, voice selectable; without validation a standard voice reads the text.

## Troubleshooting quick list
No sound/ring in browser -> allow the microphone and click "Take calls"; outbound refused -> check subscription state and minutes balance; cannot buy a second number on Solo -> plan limit; "Regulatory Bundle Required" -> compliance documents; AI analysis waiting -> buy tokens.
