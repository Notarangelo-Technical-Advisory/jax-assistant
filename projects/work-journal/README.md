# Work Journal

MAISIE keeps a journal of what Jack did, when he did it, and for which client. Jack does many things for a few minutes at a time across a day, so the journal gives him the record he needs to fill in his time entries and to see where his time went.

*Last updated: 2026-10-13*

## Status

| Part | What it does | Status |
| --- | --- | --- |
| Collection job | Reads GitHub, Jira and Claude Code every 15 minutes on Jack's Mac | Built 2026-10-13. Needs installing with launchd, and a Jira token for Jira |
| `/journal` page | Summary by week, day and client, with a click through to each item | Built 2026-10-13 |
| `get_journal` tool | MAISIE answers "What did I do for IHRDC yesterday?" in chat and VS Code | Built 2026-10-13 |

## What is collected

- **GitHub**, through Jack's `gh` login: pull requests opened, merged, closed and reopened; reviews and review comments; comments on issues and pull requests; issues opened and closed; pushes, with their commit messages; branches, tags and repos created; releases. Branch deletions are left out because they follow a merge.
- **Jira** (`ihrdcdev.atlassian.net`), with an API token in the Keychain: issues Jack created, each status change, each assignee change, other edits (by field name), and his comments. Changes by other people are left out.
- **Claude Code**, from the session files in `~/.claude/projects`: when Jack worked, in which repo and branch, how many prompts he typed, and the short title Claude Code gives each session. **Prompts and replies are not stored.** A session is split wherever it was idle for more than 20 minutes or moved to another repo or branch. A part with no prompt from Jack is left out, because that is a background task or a long tool run, not Jack working.

## Clients

Each item gets a client from where the work happened. The clients are MAISIE's task categories.

| Where | Client |
| --- | --- |
| Any repo in the IHRDC GitHub org, and the ihrdcdev Jira site | IHRDC |
| `solomon` | Solomon |
| `dora-tma` | DIAL |
| `Prophet-Priest-King` | PPK |
| `Grace-Pres`, `SNEP_SRT`, `bible-studies` | Church |
| `embassy-book-series` | Embassy Series |
| Everything else (`jax-assistant`, `nta-time-tracker`, `engineering-standards` and so on) | General |

The table is `REPO_CLIENTS`, `OWNER_CLIENTS` and `JIRA_SITE_CLIENTS` in `functions/src/tools/journal.ts`. A Claude Code session in a scratch folder counts for the repo of the session that made the folder.

## How time is estimated

- Items of one client less than 20 minutes apart form one work session, timed from the first item to the last.
- A session is never shorter than 6 minutes (0.1 hour, the billing step).
- A Claude Code item covers its own start to end.
- Each client's time is counted on its own. The day total counts overlapping work once, so client times can add up to more than the day total.
- These are estimates to help fill in time entries. They are not logged time.

## Where everything is

- **Firestore:** `journal` (one document per item, with a fixed id from its source, so a second run adds nothing) and `journalDays` (one summary per day, rebuilt when the day's items change). The job's progress is in `metadata/journal`. The page can only read them; only the job writes.
- **Rules and the tool:** `functions/src/tools/journal.ts`.
- **Job and readers (Mac only):** `functions/src/mcp/collect-journal.ts`, with `github-activity.ts`, `jira-activity.ts` and `claude-sessions.ts` beside it. launchd runs it from `bridge/com.notarangelo.work-journal.plist`; the log is `/tmp/work-journal.log`.
- **Web page:** `src/app/components/journal/`, with `JournalService` in `src/app/services/journal.service.ts`.
- **Tests:** `tests/functions/journal.test.mjs`, `tests/mcp/journal.test.mjs`, the journal tests in `tests/rules/firestore.test.mjs` and `tests/mcp/maisie-server.test.mjs`, and `journal.component.spec.ts`.

## Setting it up on Jack's Mac

1. Merge the pull request, so the page, the rules and the index are deployed.
2. Add the Jira token once:
   - Create a token at https://id.atlassian.com/manage-profile/security/api-tokens.
   - Run `security add-generic-password -s maisie-jira -a jnotarangelo@ihrdc.com -w` and paste the token when asked.
3. Run `cd functions && npm run journal:collect -- --dry-run` to see what would be added, then `npm run journal:collect` for the first run. It looks back 30 days for Jira and Claude Code and takes a few minutes. GitHub keeps only Jack's last 300 events, which at his current pace is about 3 days, so the GitHub part of the journal starts there.
4. Install the job:
   ```bash
   cp bridge/com.notarangelo.work-journal.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.notarangelo.work-journal.plist
   ```

## First dry run (2026-10-13, before the Jira token)

- GitHub: 257 items from the newest 300 events, back to 2026-10-10 (IHRDC 91, General 132, DIAL 23, PPK 11). The other 43 events were branch deletions and similar.
- Claude Code: 242 work sessions with prompts in the last 7 days. 558 parts with no prompt from Jack were left out.
- Estimate for 2026-10-13: IHRDC about 5.7 hours in three blocks (9:21–9:38 AM, 12:32–4:22 PM, 7:36–9:10 PM) and General about 1.0 hour, without Jira.

## Possible next steps

- Compare the journal with the time tracker and show IHRDC days with work but no time entry.
- Let Jack move an item to another client, or hide it, on the page.
- Add meetings from the IHRDC calendar, which the contact linking job already reads.
- If the Mac is off for more than about 3 days, GitHub's feed drops the oldest events. GitHub's search API could fill that gap for pull requests and reviews.
