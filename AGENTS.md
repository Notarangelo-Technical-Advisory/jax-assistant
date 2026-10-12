# Maisie (jax-assistant) — Development Rules

This app follows the shared engineering standards in [`docs/standards/`](docs/standards/README.md), copied from [`engineering-standards`](https://github.com/Notarangelo-Technical-Advisory/engineering-standards) `v1.1.1`. Do not edit `docs/standards/` in this repo. Change the standards repo instead.

This file holds only the development rules that belong to this app. `CLAUDE.md` describes Maisie's work as Jack's assistant.

## Git and deployment

- Use a branch and `git ship`, as in [`docs/standards/git-and-commits.md`](docs/standards/git-and-commits.md). The pull request needs no review. commitlint checks the commit type in a Husky `commit-msg` hook.
- Every merge to `main` deploys through `.github/workflows/deploy-and-release.yml`. It runs `tests.yml` first, then deploys hosting, Firestore rules and indexes, and Cloud Functions to the Firebase project `jax-assistant-cb47f`.
- Never run `firebase deploy`, `firebase login` or `firebase login --reauth` on a laptop.
- CI signs in with Workload Identity Federation (`WIF_PROVIDER` and `WIF_SERVICE_ACCOUNT` secrets). It writes every Cloud Function secret into `functions/.env` before the deploy.
- Monitor deploys at `https://github.com/Notarangelo-Technical-Advisory/jax-assistant/actions`.

```bash
git checkout -b feat/short-description
git add <files>
git commit -m "feat: description of change"
npm run test:all
git ship
```

## Models

An exception to [`docs/standards/ai-features.md`](docs/standards/ai-features.md), which says to use the current Sonnet. `functions/src/model.ts` defines two models:

- `MODEL` (Claude Sonnet 5.5) runs the chat and the LinkedIn drafts. The chat chooses among about 35 tools and changes tasks, calendar events, contacts and mail drafts, so a wrong choice costs Jack time to fix.
- `LIGHT_MODEL` (Claude Haiku 5.5) runs the briefing narrative, the headlines choice and both SMS calls. These are short jobs with no tool loop. It is faster and costs one twentieth as much per token.
- Set `output_config.effort` explicitly on every `LIGHT_MODEL` call. Haiku 5.5 thinks by default and its default effort is `medium`.
- `PRICE_PER_MTOK` in `functions/src/headlines.ts` must match `LIGHT_MODEL`.

## Testing

Follow [`docs/standards/testing.md`](docs/standards/testing.md). In this app, add tests at every layer that the change touches:

- A new or changed Firestore collection or rule → `tests/rules/`
- A new or changed MAISIE tool (`functions/src/tools/`) → `tests/functions/`
- Anything a VS Code client sees from the `maisie` MCP server → `tests/mcp/`
- A new or changed AppleScript that the desktop bridge runs (`bridge/applescript/`) → `bridge/tests/`
- A new or changed web page or service → a `*.spec.ts` file next to it, run against the emulators (`src/testing/emulator-testing.ts`)

`npm run test:all` runs `test:ci`, `test:site`, `test:rules`, `test:functions`, `test:mcp` and `test:bridge`. `tests.yml` runs the same suites on every pull request and before every deploy. See the Tests section of `README.md` for what each suite covers.
