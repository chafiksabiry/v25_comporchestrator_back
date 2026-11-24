---
id: telephony-onboarding-numbers
title: Telephony setup, buying a phone number, test call, voicemail and reception
product: telephony
audience: company
summary: Telephony onboarding steps per country (legal identifier, KYB documents, numbers of the company's country), phone-number purchase rules and errors (regulatory bundle, one line for Solo), test call, receiving calls in the browser, voicemail.
sources: [v25_callcenter_front/src/domain/onboarding.ts, v25_callcenter_front/src/domain/countries.ts, v25_callcenter_front/src/features/live/LiveNumberBuyer.tsx, v25_callcenter_front/src/features/onboarding/SoloIdentityStep.tsx, v25_comporchestrator_back/src/services/outboundDestinations.js, v25_callcenter_front/README.md, v25_callcenter_front/docs/PARCOURS_ET_TESTS.md, v25_comporchestrator_back/src/controllers/phoneNumberController.js, v25_comporchestrator_back/src/services/phoneLineBillingService.js, v25_comporchestrator_back/src/config/env.js, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-19
---
# Telephony setup and phone numbers

## The Telephony onboarding path
Steps (company offers): Your offer -> Company (legal identity and KYB documents) -> Team (invite managers / colleagues) -> Plan and balance (subscription by card, first prepaid top-up) -> Telephony (your number and your line) -> Test call. Accueil / Secrétariat has the same steps plus an optional "E-mails, calendar and video" step before the test call (it can be skipped and done later in Settings). For Nomad Solo the path is shorter: offer (payment), your identity (ID document and proof of address, no company identifier), your number, test call. Each step has a time budget. Subscription AND minutes are needed to continue ("an active subscription, minutes and tokens are needed to continue").

## What the Company step asks depends on the company's country
The first field is "Company country"; the legal identifier, the documents, the postcode format and the numbers that can be bought follow that country. Open countries:
- France: SIREN (9 digits, at the top of the Kbis, key-checked); documents: Kbis extract (less than 3 months old) and ID of the legal representative; 5-digit postcode; French numbers.
- United Kingdom: Companies House number (8 characters: 8 digits, or 2 letters followed by 6 digits, e.g. SC123456); documents: certificate of incorporation (or Companies House extract less than 3 months old) and ID of the director; UK postcode (e.g. SW1A 1AA); UK numbers.
- United States: EIN (9 digits, format 12-3456789, on the IRS letter assigning it); documents: Articles of Incorporation or Certificate of Formation (issued by the Secretary of State of the state of incorporation) and ID of the director; ZIP code (e.g. 10001); US numbers.
Other countries in the list (Belgium, Switzerland, Luxembourg, Germany, Spain, Italy, Portugal, Netherlands, Ireland, Canada, Morocco, Tunisia, Senegal, Côte d'Ivoire) are not open yet: choosing one shows a waiting list instead of the form. The registered office address must be a physical address (no PO box): operators require it to assign a local number. If the customer's country is unknown, ask it, or speak generically ("your company's legal identifier", "a number from your country").

## Buying a number
- Numbers are searched in the company's country (French numbers for a French company, UK numbers for a UK company, US numbers for a US company); purchase is not open for a country that is not open yet. The first line is included in every offer (nothing to pay to obtain it). France is served by Twilio. A UK regulatory bundle is required for +44. If the provider requires a regulatory bundle the error is "Regulatory Bundle Required" (the company's compliance documents must be approved first: see requirements/documents in the orchestrator).
- Each purchase goes through a Stripe payment window, then the line is billed monthly. Errors you may meet: "Payment required", "Payment / number mismatch", "Number purchase failed", "Number not available" (NUMBER_NOT_AVAILABLE, "Ce numéro n'est pas disponible."), "Provider credit insufficient", "Twilio Trial Limit Reached". If a purchase fails after payment, the message mentions a refund; if nothing is explained, escalate.
- Plan limits: Nomad Solo allows ONE line ("Nomad Solo includes 1 line": a second purchase is refused). Nomad Solo's number is a French number, used over the Internet from anywhere. Other plans include 1 line and charge extra lines monthly (price set on the offer in the catalogue, 14.99 € per month by default).
- Line billing rules (PAY-19): a first line of a TAAS company can start with a trial period; after the trial the monthly price is charged; if payment fails the line is suspended; a line suspended for one month without recovery is released. The Telephony call-center product has no free line trial. The line status shows billing status and a countdown to termination when payment is overdue.
- Terminating a number releases it (permission "telephony.terminate" for team members).

## Test call
After buying a number the "test call" rings the user's own phone from the line; the user presses 1 to validate the line. Test calls do not consume minutes.

## Receiving and making calls
- Inbound calls ring the people available in the browser ("Calls enabled" / "Take calls", microphone must be allowed); if nobody is present the call is forwarded to the owner's mobile, then to voicemail.
- Nomad Solo has an outbound keypad in the portal; outbound calls need an active or trial subscription and a minutes balance above zero. Allowed destinations by default: the company's own country (deduced from its lines) and France (+33), unless the company saved its own list of countries; premium-rate numbers are always refused.
- Voicemail: ring delay adjustable (5 to 120 seconds), caller message up to 120 seconds, voicemail screen with follow-up status (new, to call back, called back, closed) and notes. AI analysis of a message (transcription, summary, intent, urgency, callback number) needs at least 3,000 AI tokens in the balance; otherwise the message waits ("waiting for tokens").
- Greeting message: proposed by AI, editable, voice selectable; without validation a standard voice reads the text.

## Troubleshooting quick list
No sound/ring in browser -> allow the microphone and click "Take calls"; outbound refused -> check subscription state and minutes balance; cannot buy a second number on Solo -> plan limit; "Regulatory Bundle Required" -> compliance documents; AI analysis waiting -> buy tokens.
