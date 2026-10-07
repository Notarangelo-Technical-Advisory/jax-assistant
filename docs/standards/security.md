# Security

## Secrets

- Never commit a secret, an API key or a `.env` file. Secrets live in GitHub Actions secrets and reach Cloud Functions through `functions/.env` (see [ci-cd.md](ci-cd.md)).
- Never call a paid or secret-holding API from the browser. Claude, Stripe and ElevenLabs are called only from Cloud Functions.
- Never use a service account key file, in CI or on a laptop. CI uses Workload Identity Federation. Admin work on a laptop uses `gcloud auth application-default login`.

## Firestore rules

- Deny by default. Allow each collection only what the app needs.
- A user reads and writes only their own data unless a rule says otherwise, for example for an admin or for a member of the same organisation.
- Only an admin can set a role, an admin flag, or a field that decides what another user can see. A user may update the other fields of their own profile.
- No self sign-up gives a role. A user receives access through an invite or from an admin.
- Every rule change has a test that shows the right user allowed and the wrong user refused.
- Rules deploy only through CI.

## Public hosting

- Firebase Hosting serves every file in a site's `public` folder to anyone. Keep internal files, such as business plans, architecture notes and scripts, out of a public folder, or list them in that site's `ignore` list.
- `ignore` patterns are relative to the `public` folder. In a site whose `public` is `docs`, write `architecture/**`, not `docs/architecture/**`.
- After a change to a public site, open the URL of one internal file and confirm it returns 404.
- Do not turn on GitHub Pages for an app repo. It publishes a whole folder with no ignore list, even when the repo is private. PPK's Pages site was switched off on 2026-10-07.

## Authentication

- Use Firebase Auth. Each route that needs a signed-in user uses `authGuard`. Routes for signed-out users only, such as sign-in and invite links, use `noAuthGuard`.
- Check permissions in the Firestore rules and in Cloud Functions. A check in the browser alone is not a security check.

## Sending on a user's behalf

- Where an app can send email or messages for a user, it creates a draft by default and lets the user send it.
