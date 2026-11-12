---
id: calls-and-qa
title: Calls, call history, call recordings and AI quality analysis (QA)
product: platform
audience: all
summary: Call journal, call report, AI Call Quality Analysis metrics and calibration, coaching briefings, fraud detection, token cost and common call errors.
sources: [v25_dash_calls_backend/src/controllers/calls.js, v25_dash_calls_backend/src/controllers/callsAnalytics.js, v25_callcenter_front/src/harx/calls/i18n.ts, v25_callcenter_front/src/harx/calls/QualityAssurancePanel.tsx, v25_reporchestrator_front/src/i18n/locales/en.json, v25_callcenter_front/README.md]
verified: 2026-11-12
---
# Calls and Call Quality Assurance (QA)

## Call history
- REP side: "My Calls" ("Review your performance and interaction details"): Call Records, filter by prospect ("Calls for this prospect"), call report, recording player and transcript. Company side: calls dashboard with details per call. Telephony app: "Journal d'appels" (call journal) with test-call block above it.
- A call record stores the REP, the lead, status, duration, recording (the recording can arrive late: the platform retries to fetch it from the telephony provider), transcript and the AI analysis.

## AI quality analysis (QA)
Each analysed call gets scores and a summary ("Call Summary", "AI Insights", "Quality analysis"). Metrics: agent fluency, prospect sentiment, fraud detection (call shows "Fraud detected" or "No fraud"), script coherence, argumentation quality, transaction analysis. The prospect outcome is classified (e.g. argued call - transaction declined; argued call - appointment taken; called - wants a callback; called - unreachable; called - voicemail; called - wrong number). Very short calls show "No AI analysis".
- *Calibration*: the user can confirm ("Agree") or contest ("Disagree") the AI score; an explanation is required when disagreeing ("Add an explanation when you disagree").
- *Coaching briefings*: excellent calls are suggested as inspiration, critical calls as "call to rework"; briefings can be shared anonymised with other REPs of the gig if the company chooses.
- Analysis consumes AI tokens; with no balance the app shows a payment-required message (402) and a link to billing.
- In the Telephony app the Quality screen currently shows illustration data (as in the company application).

## Rules that block a REP call
"Call blocked. You must be enrolled, complete gig trainings, and call only during an active reserved slot." (see topic schedules-attendance-slots). A negative company escrow/commission wallet from AI-validated calls can also be flagged.

## Typical issues
Recording missing right after the call -> wait a few minutes then refresh; analysis refused for lack of tokens -> buy tokens; call not listed in Telephony journal -> make sure the call was a real (non-test) call on a line of the company.
