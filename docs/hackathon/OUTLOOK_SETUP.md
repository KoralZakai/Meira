# Outlook and Teams: the one-time Azure setup (≈ 5 minutes)

Meira reads Outlook through **Microsoft Graph** with your own sign-in: a public
client with PKCE, **no secret anywhere**, read-only (`Calendars.Read`). The only
thing the build needs is an **Application (client) ID**, which is public by
design, like the Google OAuth client id.

> Without it, the Menu row honestly says *"Not set up in this build"*.
> **Phone calendars** already reads Outlook if the Outlook app is on the phone
> with calendar sync on.

## Steps (the account owner does these; Claude doesn't create accounts)

1. Go to https://entra.microsoft.com → **App registrations** → **New registration**.
2. Name: `Meira`. Supported account types: **Accounts in any organizational
   directory and personal Microsoft accounts**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value
   `lumi://outlook`. Click **Register**.
4. **API permissions** → Add → Microsoft Graph → *Delegated* →
   `Calendars.Read`, `User.Read`, `offline_access`. (No admin consent needed
   for personal accounts.)
5. Copy the **Application (client) ID** and add it to the EAS `preview`
   environment:
   ```bash
   eas env:create --environment preview --name EXPO_PUBLIC_MS_CLIENT_ID --value <client-id> --visibility plaintext
   ```
6. Rebuild (`npm run android:local`). In Menu → Calendars → **Outlook · Teams** →
   sign in.

## What arrives

- Every Outlook event for the next 30 days, occurrences expanded; declined and
  cancelled events are skipped.
- A **Teams** meeting arrives as remote, with its join link and no journey.
  `"Microsoft Teams Meeting"` in the location field is never geocoded.
- An in-person meeting arrives with its venue, route, leave time and wake alarm.
- The same meeting in Outlook *and* Google lands **once**.
