# Git and Commits

## Branches

Every change reaches `main` through a pull request. The pull request is a record of the change, not a review step. See [decisions/0007](https://github.com/Notarangelo-Technical-Advisory/engineering-standards/blob/main/decisions/0007-pull-requests-for-the-record.md).

- Create a branch before you change anything: `git checkout -b <type>/<short-description>`, for example `fix/radar-chart-labels` or `feat/couples-invite`. The type is one of the commit types below.
- Keep a branch to one change.
- Merge with `git ship`. It pushes the branch, opens a pull request, squash-merges it into `main` straight away and deletes the branch.
- A pull request needs no review or approval.
- Never commit directly to `main`. A merge to `main` deploys to production.
- Run the tests before `git ship`. It does not wait for CI. The deploy job runs the tests again and stops the deploy if they fail.
- Do not merge a change to `.github/workflows/` while an earlier deploy of the same app is still running. That run's release job then cannot push its tag, because GitHub does not let the workflow token create a tag whose workflow files differ from `main`. The deploy itself still succeeds, and the next run's release includes both changes. This happened to Solomon on 2026-10-07.

## Commit messages

- Use conventional commits: `<type>(<optional scope>): <what changed>`. For example, `fix(tts): stop audio cutting off after 30 seconds`.
- Allowed types are `feat`, `fix`, `perf`, `docs`, `refactor`, `chore`, `style` and `test`.
- There is no `ci:` type. Use `chore:` for changes to workflows and build settings.
- commitlint checks the type in a Husky `commit-msg` hook. The shared config will live in `config/commitlint.config.js` in this repo.
- Write the subject so a reader understands the change without opening the code. Say what is different for the user where you can.

## Versions

The deploy workflow works out the next version from the commit subjects since the last tag. It reads only the subject line, never the body.

| Any subject since the last tag | Version change |
| --- | --- |
| Contains `BREAKING CHANGE` or `[major]` | Major (`x.0.0`) |
| Starts with `feat:` or `feat(scope):`, or contains `[minor]` | Minor (`0.x.0`) |
| Anything else, including `docs:` and `chore:` | Patch (`0.0.x`) |

- `feat!:` does not give a major version. Put `[major]` in the subject instead.
- `BREAKING CHANGE:` in the commit body has no effect on the version.

- Every deploy gets a new version and a GitHub Release. This includes deploys that only change docs. Each running build can then be matched to a tag.
- `[skip ci]` in a commit message stops all workflows. Only the automated doc-update workflows use it, so that their commits do not start another deploy.
