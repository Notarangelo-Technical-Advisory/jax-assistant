# Engineering Standards: Summary

These rules apply to every Notarangelo Technical Advisory app. Each section links to the full rule. Where an app's `AGENTS.md` names an exception, the exception applies to that app only.

## Git and commits ([detail](git-and-commits.md))

- Work on a short-lived branch named `<type>/<short-description>` and merge it with `git ship`. Do not commit to `main` directly.
- The pull request is a record of the change. It needs no review, and `git ship` merges it straight away.
- Commit types are `feat`, `fix`, `perf`, `docs`, `refactor`, `chore`, `style` and `test`. There is no `ci:` type, so use `chore:` for CI changes.
- `feat` gives a minor version, `BREAKING CHANGE` or `[major]` gives a major version, and every other commit gives a patch version.

## Testing ([detail](testing.md))

- Every code change ships with tests. A change without tests is not finished.
- Most tests are integration tests on the Firebase emulators, using the real security rules.
- Name each test for the behaviour a user would notice, and cover the refusals as well as the success path.
- Before you commit, break the check you added and confirm a test fails.
- Run `npm run test:all` (or `npm run test:ci` where there is no `test:all`) before you push. Never skip, disable or weaken a test to make it pass.

## CI/CD ([detail](ci-cd.md))

- Deploy only through GitHub Actions. Never run `firebase deploy` or `firebase login` on a laptop.
- CI uses Node 22, `npm install` (not `npm ci`) and `firebase-tools` 15.6.0. Certificate checks stay on, so never set `NODE_TLS_REJECT_UNAUTHORIZED`.
- CI signs in to Google Cloud with Workload Identity Federation. Never use service account key files.
- Cloud Function secrets go into `functions/.env`, written by CI before the deploy.

## Coding ([detail](coding.md))

- Use Angular 22 with standalone components only, and the Firebase JS SDK with `rxfire`. Do not use AngularFire.
- Firebase calls belong in services, not in components.
- TypeScript strict mode is on. ESLint must pass.
- Use the app's design tokens. Never hardcode colours, spacing or fonts.

## Security ([detail](security.md))

- Never commit secrets. Every Firestore rule change has a test.
- Only an admin can change a role or another user's access.
- A public hosting site serves every file in its folder. Keep internal files out of it.

## Documentation ([detail](documentation.md))

- Update `docs/architecture/architecture.md` in the same pull request when the stack, data model, rules, functions or CI change.
- Write in plain English for readers whose first language is not English.

## AI features ([detail](ai-features.md))

- Call the Claude API only from Cloud Functions. Never call it from the browser.
- Read the response's text block by its type, not by its position.
