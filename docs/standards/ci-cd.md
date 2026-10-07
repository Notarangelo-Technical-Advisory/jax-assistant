# CI/CD and Deployment

## Deploy only through GitHub Actions

- Every deploy runs in GitHub Actions. A merge to `main` starts it.
- Never run `firebase deploy`, `firebase login` or `firebase login --reauth` on a laptop. This also applies to Firestore rules.
- `package.json` has no `deploy` scripts, so that nobody runs a deploy from a laptop by mistake.
- For an urgent fix, use a normal branch and `git ship`. The pipeline takes about 10 minutes.

## Pipeline

Every app's `deploy-and-release.yml` has these jobs, in this order:

1. `version`: works out the next version from the commits (see [git-and-commits.md](git-and-commits.md)).
2. `build`: installs, runs `npm run test:ci`, and builds with `npm run build:prod`. It writes the version into `src/environments/version.ts`.
3. `deploy`: builds Cloud Functions, writes `functions/.env` and runs `firebase deploy`.
4. `release-notes`: asks the Claude API to write release notes from the commits. If the call fails, it groups the commits under feat, fix, perf, docs, refactor and other.
5. `create-release`: creates the git tag and the GitHub Release.

Other rules:

- Set a `concurrency` group, so that two deploys of the same app never run at the same time.
- An app may add a faster path for changes that touch only `functions/`, as Solomon does with `deploy-functions.yml`.
- These jobs will move into reusable workflows in this repo. Each app's workflow will then call them with its project ID and build path.

## Settings

| Setting | Value | Why |
| --- | --- | --- |
| Node for the build | 22 | Angular 22 needs Node 22.22.3 or later |
| Node for Cloud Functions | 22 (`"engines": { "node": "22" }` and `"runtime": "nodejs22"`) | Node 20 stopped receiving security fixes in April 2026. Each app moves once it is on Angular 22. |
| Install command | `npm install`, never `npm ci` | [decisions/0001](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0001-npm-install-not-npm-ci.md) |
| `firebase-tools` | `15.6.0`, the same in every job | [decisions/0005](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0005-firebase-tools-15-6-0.md) |
| `actions/setup-node` | `@v4` with `cache: npm` | |
| Build artifact | `dist/<project>/browser`, kept for 1 day | |

## Signing in to Google Cloud

- CI uses Workload Identity Federation through `google-github-actions/auth@v2` with `token_format: 'access_token'`. It passes the token to the Firebase CLI as `FIREBASE_TOKEN`.
- Never store a service account key file as a secret.
- Each app uses the pool `github-actions-pool` and the provider `github-provider`. Its `WIF_PROVIDER` secret holds the provider's full resource name.
- Create the provider without `--allowed-audiences`. See [decisions/0004](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0004-wif-without-allowed-audiences.md).

## Cloud Function secrets

- CI writes every secret that a function needs into `functions/.env` before `firebase deploy`. Second-generation functions load this file when they start.
- `functions/.env` is listed in `.gitignore`.
- Do not use `gcloud run services update --update-env-vars`, `firebase.json` secrets, or the `secrets` option on `onCall()`. See [decisions/0002](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0002-function-secrets-in-functions-env.md).

## Certificate checks in CI

- Do not set `NODE_TLS_REJECT_UNAUTHORIZED` in CI. It turns off certificate checks while the Firebase CLI sends the deploy token. See [decisions/0006](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0006-certificate-checks-on-in-ci.md).
