---
id: platform-overview
title: HARX platform overview, products and user types
product: platform
audience: all
summary: What HARX is, its two products (TAAS and Telephony), user types (company, REP, call-center staff) and where things live.
sources: [v25_process_connections/main.tsx, v25_callcenter_front/README.md, v25_callcenter_front/src/domain/plans.ts, v25_comporchestrator_front/src/components/CompanyOnboarding.tsx]
verified: 2026-11-12
---
# HARX platform overview

## Two products on harx.ai
- *TAAS - Transaction-as-a-Service*: a company describes the result it wants as a GIG; HARX REPs (customer-service, telesales and support professionals, human or AI) work on it; the company pays only for the result it defined. Landing text: "Uber connects you to drivers, Airbnb to accommodation, HARX connects you to customer-service professionals and only bills you when they deliver a result." On the home page the company side is "Company: publish a gig" (shown as "coming soon" on the landing page) and the REP side is "REPS: find gigs" for customer-service professionals looking for missions.
- *HARX Téléphonie (Telephony)*: "Your telephony, operational in 5 minutes." A phone number from your country, inbound and outbound calls, a reception/secretariat service and an AI assistant. Four offers: Nomad Solo, Accueil / Secrétariat, Company Full Scope In & Out, Contact Centre Multi-clients (see topic telephony-offers). The home-page buttons are "Découvrir TAAS" and "Ouvrir HARX Téléphonie" (the Telephony app lives under harx.ai/telephony).

## Site structure
harx.ai is a shell that loads separate applications (micro-frontends): the home page, registration/sign-in (/auth/...), the company application ("orchestrator": onboarding, gigs, matching, subscription), the REP application (marketplace, planning, calls, wallet), the Telephony application (/telephony) and the call-center application (/call-center, older variant). The session is shared across them: one HARX login works everywhere. The language of the site can be switched at the top right (French, English, Spanish, Arabic).

## User types
- *Company owner*: created the company account; full access.
- *Company team member*: invited by the owner, with permissions per area (see topic roles-permissions).
- *Call-center staff / agent*: an account provisioned by a call center, linked to an employer company (can work for several centers).
- *REP (representative)*: a professional who builds a profile, gets matched to gigs, trains, reserves time slots and takes calls.
