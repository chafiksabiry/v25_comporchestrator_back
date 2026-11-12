---
id: whatsapp-support-faq
title: About the HARX WhatsApp AI Support (how it works, linking your account, privacy)
product: platform
audience: all
summary: What the WhatsApp assistant is, how to link a WhatsApp number to a HARX account, what data it can see and how to disconnect.
sources: [v25_comporchestrator_back/src/whatsapp/identity.js, v25_comporchestrator_back/src/whatsapp/routes.js, v25_process_connections/components/WhatsAppSupportButton.tsx]
verified: 2026-11-12
---
# HARX WhatsApp AI Support

The green WhatsApp button ("AI Support") on harx.ai opens a chat with the HARX AI assistant on WhatsApp. It answers in the user's language (French, English, Arabic, Moroccan Darija, Spanish and more) and can help with sign-up, onboarding, gigs, plans, telephony, calls, schedules and troubleshooting.

## Visitor mode vs linked account
- Not logged in (or opened without a code): general help only; no account data.
- Logged in on harx.ai: the button creates a one-time code (HARX-XXXXXXXX, valid about 30 minutes, single use) in the pre-filled message. Sending it links THAT WhatsApp number to the logged-in HARX account, so the assistant can see the plan, limits, balances and permissions of that account and personalise answers. A phone number alone is never accepted as proof of identity.
- Disconnect: ask the assistant to unlink the WhatsApp number at any time.

## Privacy
The assistant only reads the linked account, only with that user's rights, and never shows another user's data. Never send passwords, verification codes or card numbers in WhatsApp. Conversations are stored to keep context and for support tickets.
