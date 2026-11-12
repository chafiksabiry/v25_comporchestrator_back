---
id: leads-crm-deals
title: Leads / prospects, contact import, CRM (Zoho) and deals
product: taas
audience: company
summary: Importing contacts (CSV/Excel or Zoho CRM), required fields, lead dispositions and archive, claim/release of a lead in the cockpit.
sources: [v25_comporchestrator_front/src/components/onboarding/UploadContacts.tsx, v25_dashboard_backend/src/routes/leads.js, v25_dashboard_backend/src/models/Lead.js, v25_dash_calls_backend/src/models/Lead.js, v25_comporchestrator_front/src/components/ZohoFieldMappingModal.tsx, v25_comporchestrator_front/src/i18n/locales/en.json]
verified: 2026-11-12
---
# Leads, contacts and CRM

## Importing contacts (onboarding step 5 "Upload Contacts")
- The import screen ("Import contacts for multi-channel engagement") accepts .csv, .xlsx and .xls files and also a connection to Zoho CRM (Zoho authorisation, then a field-mapping dialog to map Zoho fields to HARX fields; modules such as leads/deals can be imported).
- You must select the gig the leads belong to first (error "select a gig first") and the user must be identified ("user id not found" means the session is missing: log in again).
- For CSV files the separator (comma or semicolon) is detected automatically. Rows that do not have the required fields are ignored; if no valid row remains the import answers "no valid leads found". On success the app confirms how many leads were saved.
- Fields used by the lead model follow the Zoho-style names (Deal_Name, Email_1, Phone, Pipeline, Stage, Activity_Tag...). A lead is linked to the company, the gig and optionally an assignee.
- A preview shows each lead (including email, or "no email").

## Working leads
- Leads can be created one by one, in bulk, archived (single or bulk), and updated.
- Each call outcome sets a *disposition* on the lead (examples shown in call analysis: not interested, appointment taken, callback requested, unreachable, voicemail, wrong number, already equipped); a disposition may need confirmation by the company.
- In the REP cockpit a REP *claims* a lead before calling it and *releases* it afterwards, so two REPs do not call the same prospect at once.
- Lead types hot / warm / cold are configured on the gig.

## Permissions
Team members need leads permissions: view, import, create, edit, archive, export (topic roles-permissions).

## Not confirmed
Native CRM integrations other than Zoho in the TAAS app, and two-way sync behaviour, are not documented here: for HubSpot, Dynamics or API/webhooks (Telephony Full Scope / Multi-clients "Integrations" group) refer the user to support if they need specifics.
