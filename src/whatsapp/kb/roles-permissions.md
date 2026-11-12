---
id: roles-permissions
title: Roles, team members and permissions
product: platform
audience: company
summary: Owner, team members (presets and custom roles), agents, REPs, permission groups and what 403 / access errors mean.
sources: [v25_registration_backend/src/models/CompanyMembership.js, v25_registration_backend/src/models/CompanyRole.js, v25_registration_backend/src/routes/companyMemberRoutes.js, v25_comporchestrator_front/src/constants/companyPermissions.ts, v25_comporchestrator_back/src/middleware/companyAccess.js, v25_callcenter_front/src/domain/plans.ts]
verified: 2026-11-12
---
# Roles and permissions

## Who can do what
- *Owner*: created the company; full access to everything, including inviting teammates, subscription and phone numbers.
- *Team member*: invited by email into the company ("company members"). A membership has a status (pending, invited, active), a preset (admin, operator, readonly or custom) and optionally a named custom role created by the company. Permissions are a map "<group>.<action>" set to true/false.
- *Call-center staff (agent)*: an account provisioned by a call center; linked to the employer company (an agent may work for several centers, one is the default; the active one is chosen in the app).
- *REP*: independent professional; has no company; uses the REP application.
- In HARX Telephony the access levels are shown to users as owner (titulaire), manager (responsable) and collaborator; Nomad Solo is single-user.

## Permission groups (company application)
Gigs (view, create, edit, delete, activate/pause), Leads/Prospects (view, import, create, edit, archive, export), Telephony (view, search, buy, assign, terminate, test call), Scripts, Knowledge base, Matching/REPs (view, invite, accept/decline), Training, and more. The full generated list is in the permissions catalogue topic.

## Typical problems
- "You do not have access to this company" (403): the logged-in user is not the owner, an invited member, or call-center staff of that company. Check they are logged in with the right account and that the invitation was accepted.
- A button is missing or disabled: the member lacks the corresponding permission; the owner can change it in the team page.
- Team management endpoints: list members, invite, re-invite, update, remove, list/create/update/delete roles, presence.
- Nomad Solo: inviting a member or agent is refused ("Nomad Solo is designed for one user"); upgrade to another offer.
