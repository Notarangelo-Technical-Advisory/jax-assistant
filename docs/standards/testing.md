# Testing

## The rule

- Every code change ships with automated tests. A change without tests is not finished.
- Run the tests before `git ship`, because `git ship` does not wait for CI. The deploy job runs the tests before every deploy, and a failing test stops the deploy.
- Never skip, disable or weaken a test to make it pass. If a test is wrong, fix the test in the same pull request and say why in the commit message.

## What kind of test to write

Most tests are integration tests. These run real services, guards, components and Cloud Functions against the Firebase emulators, using the app's real `firestore.rules`.

| Kind | Share | Use it for |
| --- | --- | --- |
| Integration (emulators) | Most tests | Services, guards, components, Cloud Functions, security rules |
| Unit | Some | Pure logic with no Firebase access, such as scoring or date maths |
| End-to-end (Playwright) | A few | Smoke tests of the most important user journeys |
| Static checks | Always | TypeScript strict mode and ESLint |

Add tests at every layer that the change touches:

- A new or changed Firestore collection or rule → a test in `src/app/firestore-rules.spec.ts` (or `tests/rules/` where the app has it).
- A new or changed Cloud Function → a test in `tests/functions/`.
- A new or changed page or service → a `*.spec.ts` file next to it, run against the emulators.

## How to write a test

- Name the test for the behaviour a user would notice, in plain words. Write "refuses a second contact with the same email", not "testValidateContact".
- Test the refusals and safety checks, not only the success path. For a rule, test that the wrong user is refused as well as that the right user is allowed.
- Do not depend on today's date. Use fixed dates in the past, so the test does not start failing as time passes.
- Start each test from empty emulators. Use the clear helper in `src/testing/emulator-testing.ts`, and check that it really empties Firestore.
- Never call the real Claude API, Stripe or ElevenLabs from a test. Replace them with a fake.
- Prove the test works: before you commit, break the main check you added, confirm a test fails, then restore the check.

## Script names

Every app uses the same `package.json` script names:

| Script | What it runs |
| --- | --- |
| `test` | Browser tests on the emulators, in watch mode |
| `test:ci` | Browser tests on the emulators, headless, run once. CI runs this. |
| `test:rules` | Security rule tests with `node --test` (where the app has them) |
| `test:functions` | Cloud Function tests on the emulators (where the app has them) |
| `test:e2e` | Playwright tests (where the app has them) |
| `test:all` | Every suite above that the app has |

- Each suite uses an emulator project ID that starts with `demo-`, for example `demo-solomon-browser`. Firebase does not let a `demo-` project connect to production.
- Shared helpers for signing in as each role and for seeding documents are in `src/testing/emulator-testing.ts`.

## Checks that stay manual

- Responsive layout on a phone and a desktop.
- Keyboard navigation and colour contrast.
