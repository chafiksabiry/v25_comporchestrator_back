---
id: schedules-attendance-slots
title: Planning, Reserved Slots, Attendance, Late Attendance, Early Check-out, schedule requests
product: platform
audience: all
summary: How REP slots are reserved, how Attendance / Late attendance / Early check-out / no-show / last-minute cancellation are computed, and Telephony schedule requests (late arrival, early departure, leave).
sources: [v25_reporchestrator_front/src/utils/planningMetrics.ts, v25_reporchestrator_front/src/components/dashboard/pages/SessionPlanning.tsx, v25_matching_backend/src/models/ReservationSlot.js, v25_matching_backend/src/routes/slotRoutes.js, v25_dash_calls_backend/src/controllers/calls.js, v25_registration_backend/src/services/callCenterScheduleValidation.js, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-12
---
# Planning, slots and attendance

## Slots and reservations (TAAS)
- A company defines the gig's availability (weekly schedule, time zone) and generates call slots in "Session Planning" (step 10 of onboarding: "Schedule call slots and prioritize leads"). The planning grid shows available vs reserved slots, weekly overview (Available Slots, Reserved Slots, Gig Hours) and AI recommendations. Calls are forbidden from 13:00 to 14:00 ("legal lunch").
- A REP reserves slots on the gigs they are enrolled in (Planning page: "Manage and book your call slots with ease"). A reservation has a status: reserved or cancelled. One reservation per REP per slot occurrence. Times are displayed in the user's time zone. Engagement targets are shown per day, week and month (planned hours vs required hours).
- If a REP already reserved the same slot on another gig, a dialog "Slot already reserved on <gig>" offers SWITCH to cancel that reservation and take it here.
- Calling is only allowed during a reserved slot: the call is blocked with "Call blocked. You must be enrolled, complete gig trainings, and call only during an active reserved slot." (no reserved slot for this gig at the current time). A REP can only call a gig they are enrolled in and whose trainings are complete.
- The plan limits how many REPs can be active on the planning grid ("The <plan> plan allows N active REP on the planning grid").

## Attendance KPIs (REP Planning page, per gig and period: week, month, quarter, year)
- *Attendance* = past reserved slots in which there was real telephony activity during the slot window / all past reserved slots. Any call attempt overlapping the window counts, even a failed or 0-second attempt. Shows "Pending" while no reserved slot has ended yet.
- *No-show* = a past reserved slot with no call attempt during its window. No-shows lower the Attendance score.
- *Late attendance* = share of past reserved slots where the first call started after a grace period from the slot start.
- *Early check-out* = share of past reserved slots where the last call ended before the end of the slot minus a grace period.
- Grace period = 15% of the slot duration, but never less than 2 minutes and never more than 10 minutes.
- *Last-minute cancellation rate* = cancelled reservations that were cancelled less than 2 hours before the slot start, as a share of reservations in the period.
- Company side: Attendance Tracker, Scorecard and Report (per REP: sessions attended vs missed, exportable); a target score of 95% is used for "Elite" status in the scorecard.
Advice for a REP with a low score: reserve fewer but realistic slots, start calling at the slot start, stay until the end, cancel early (more than 2 hours before).

## Telephony (call-center) schedules and absence requests
Call-center agents have shifts per queue and can submit requests: type leave, sick, absence, late_arrival, early_departure or other. Late arrival and early departure need a time (HH:MM). Rules: dates in YYYY-MM-DD, end date not before start date, a request cannot exceed 120 days, cannot start more than 30 days in the past, the reason is at most 500 characters and mandatory for "other". Request statuses: pending, approved, rejected, cancelled (managers decide). Error texts: "Le type de demande est invalide.", "La date de début est invalide.", "La date de fin précède la date de début.", "Une demande ne peut pas dépasser 120 jours.", "Une demande ne peut pas remonter à plus de 30 jours.", "L'heure d'arrivée prévue est obligatoire (HH:MM).", "Le motif ne peut pas dépasser 500 caractères.", "Précisez le motif de votre demande.".
