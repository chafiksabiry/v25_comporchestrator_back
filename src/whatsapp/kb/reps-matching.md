---
id: reps-matching
title: REP side - profile, matching, enrollment, training, workspace, wallet and payouts
product: taas
audience: rep
summary: The REP journey: sign-up and profile wizard, marketplace and applying, invitations, matching results and statuses, training/certification, workspace and calls, wallet and payouts.
sources: [v25_reporchestrator_front/src/routes/DashboardRoutes.tsx, v25_reporchestrator_front/src/i18n/locales/en.json, v25_matching_backend/src/models/GigAgent.js, v25_repscreationwizard_backend/src/models/Plan.js, v25_repscreationwizard_backend/src/routes/agentRoutes.js, v25_comporchestrator_front/src/components/onboarding/MatchHarxReps.tsx]
verified: 2026-11-12
---
# REP (representative) journey

## Pages of the REP application
Dashboard, Marketplace (gigs), Gig details, Company profile, Profile, Account Settings, Payouts, Wallet, Learning, Training, Certification, Operations, Workspace, Community, Import leads, Session Planning, Calls, Call report.

## Becoming a REP
1. Create an account (REP sign-up; LinkedIn import of the profile is available) and verify the email.
2. Profile wizard: personal info, skills (technical, professional, soft), languages (with language assessments), industries, activities, experience, CV/video (the wizard supports CV import and review).
3. Skills assessment and onboarding steps ("REP onboarding"), then optionally a REP subscription (REP plans, "Select Your Plan") - check get_subscription_plans for what is published.
4. Browse the gig Marketplace and press "Apply Now" or accept an invitation ("You're invited": Accept / Decline).

## Matching
The platform scores a REP against a gig requirement by requirement (languages, skills, industries, availability...) and returns perfect_match, partial_match, no_match (and neutral_match for some criteria). Companies use "MATCH HARX REPS" (step 13) to invite matching REPs.

## Gig-REP statuses
invited, requested, accepted, rejected, expired, removed, enrolled, archived, cancelled (plus pending/completed in some views). A REP must be *enrolled* and have completed the gig's trainings before calling; then reserve a slot (topic schedules-attendance-slots).

## Training and certification
Training journeys per gig, a Learning page, certification pages ("Certification" and journey certificates). A "workspace guard" message tells a REP what is missing before accessing the workspace (for example trainings).

## Wallet and payouts
Wallet & Earnings page: Available Balance, Pending Earnings, Lifetime Earnings, Transaction History, "Download Statement" and "Withdraw Funds". Earnings come from commissions per call / per transaction (plus bonuses defined on the gig); withdrawals use a one-time code (OTP) flow. Sale commissions are released after a 14-day retraction window (a platform job runs hourly); AI-validated calls and sales that the company never decided on are auto-resolved after their review deadline. Other payout delays are not confirmed here.

## Company-side
Companies see applicants and enrolled REPs in the matching dashboard, can invite, accept or decline (permission group matching: view, invite, decide), and the plan limits the active REPs.
