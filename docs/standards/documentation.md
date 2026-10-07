# Documentation

## Files every app has

| File | What it holds |
| --- | --- |
| `README.md` | What the app does, how to run it locally, and how to run the tests |
| `AGENTS.md` | Rules for this app only: Firebase project, URLs, data model, domain rules, and any exception to these standards with its reason |
| `CLAUDE.md` | `@AGENTS.md` and `@docs/standards/README.md`, plus anything only Claude Code needs |
| `docs/architecture/architecture.md` | Stack, Firestore collections, rules, Cloud Functions, services, hosting and CI |
| `docs/standards/` | A copy of this repo's `standards/` folder. Do not edit it in the app. |

## Keeping docs current

- Update `docs/architecture/architecture.md` in the same pull request when any of these change: the stack or a major dependency, a Firestore collection or rule, a Cloud Function, a key service, the Firebase or hosting setup, or the CI pipeline.
- Update the in-app help in the same pull request when a change is visible to users, where the app has in-app help.
- Record a domain rule in `AGENTS.md` when the code does something that looks wrong but is deliberate. Say what the rule is, where it is enforced, and what not to "fix". NTA's rule on zero-activity status report sections is an example.
- Requirements docs and implementation summaries are not required. The architecture doc, the pull request and the git history record each change. An app may keep them as an exception named in its `AGENTS.md`, as PPK does.
- An automated doc-update workflow after deploy is allowed. It is in addition to updating docs in the pull request, not a replacement for it.

## How to write

- Write in plain English for readers whose first language is not English. Do not use idioms or metaphors.
- Put the main point first.
- Use names, numbers, file paths and dates, not general descriptions.
- Use bullets and tables for rules and steps.
