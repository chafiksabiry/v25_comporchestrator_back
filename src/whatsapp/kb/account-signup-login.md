---
id: account-signup-login
title: Sign-up, email verification, login, password and phone change
product: platform
audience: all
summary: Real rules for creating an account, verification codes, login, password change/recovery and phone change, with the exact error messages.
sources: [v25_registration_backend/src/services/authService.js, v25_registration_backend/src/services/userService.js, v25_registration_backend/src/routes/authRoutes.js, v25_registration_backend/src/routes/userRoutes.js]
verified: 2026-11-12
---
# Sign-up, login and account security

## Create an account
- Sign-up asks for email, password, full name and phone (REP and company have their own registration entries; the Telephony product uses /auth/register-call-center?product=callcentre then returns to /telephony).
- Password rule: at least 8 characters, with letters AND numbers. Otherwise the error is "Password must be at least 8 characters with letters and numbers".
- The email must be unique: if it already exists the error is "Email already registered" (use sign-in or recover the password). Phone numbers do NOT have to be unique.
- A 6-digit verification code is sent BY EMAIL only (it is never shown on screen). It is valid 10 minutes. A wrong or old code gives "invalid or expired code. Please try again." Ask for a new code if it expired (resend verification). Check the spam folder.

## Log in
- Login checks email and password, then the account must be verified. Errors: "Invalid email", "Invalid password", "Account not verified". On login a new 6-digit emailed code (10 minutes) can be required to verify the account.
- First login after registration marks the account as "first time" and starts onboarding.
- Sign-in with LinkedIn also exists.
- Invited agents/REPs can receive a one-time invite or re-engagement login link (expires; request a new one if expired).

## Forgot or reset password (not logged in)
Request a verification code with your email: if the email is not registered the error code is EMAIL_NOT_REGISTERED ("Email not registered"); otherwise a 6-digit code is emailed (valid 10 minutes), then it is verified and a new password is set. The code is never returned by the API, only emailed.

## Change password (logged in)
1. Request a change: a verification code is sent to the CURRENT email of the account (error "No email registered on this account" if none).
2. Confirm with the code, the new password (8 to 128 characters; errors: "New password must be at least 8 characters", "New password must be at most 128 characters") and, when required, the current password ("Current password is required", "Current password is incorrect").
3. Code errors: "No pending password change found - request a new code", "Verification code has expired - request a new one", "Invalid verification code".

## Change email
Request change then confirm with a code (only the account holder can do it, while logged in).

## Change phone number
Phone must be 5 to 32 characters in a valid format ("Phone number must be between 5 and 32 characters", "Invalid phone number format"). A 5-minute SMS code (OTP) confirms it: "OTP has expired. Please request a new one." / "Invalid OTP. Please try again."

## Profile
Full name must be 2 to 120 characters ("Full name must be at least 2 characters", "Full name must be at most 120 characters"). Account settings and profile editing are available in each application (REP: Profile and Account Settings pages).

## Safety
HARX staff never need your password or verification codes; never share them in chat.
