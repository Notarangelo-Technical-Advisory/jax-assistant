# Work Journal

MAISIE keeps a journal of what Jack did, when he did it, and for which client. Jack does many things for a few minutes at a time across a day, so the journal gives him the record he needs to fill in his time entries and to see where his time went.

*Last updated: 2026-10-29*

## Status

| Part | What it does | Status |
| --- | --- | --- |
| Collection job | Reads GitHub, Jira, Claude Code and the calendars every 15 minutes on Jack's Mac | Built 2026-10-13 and installed. Jira collected from 2026-10-14 |
| Meetings | Ended meetings on the Jax and IHRDC calendars, under their client | Built 2026-10-14 |
| Recordings | Meetings recorded in Wispr Flow that can be tied to a client | Built 2026-10-14 |
| Sent email | Emails Jack sent from Apple Mail to a client, or about a client's work | Built 2026-10-16 |
| NTA Business | Jack's own business repos have their own client, not General | Built 2026-10-16 |
| `/journal` page | Summary by week, day and client, with a click through to each item. Filters for a date range and one client or all clients | Built 2026-10-13. Filters added 2026-10-14 |
| `get_journal` tool | MAISIE answers "What did I do for IHRDC yesterday?" in chat and VS Code | Built 2026-10-13 |
| Timeline | Each day as a line from morning to midnight, with the work in each client's colour and the breaks between it. `get_journal` gives MAISIE the same breaks | Built 2026-10-29 |

## What is collected

- **GitHub**, through Jack's `gh` login: pull requests opened, merged, closed and reopened; reviews and review comments; comments on issues and pull requests; issues opened and closed; pushes, with their commit messages; branches, tags and repos created; releases. Branch deletions are left out because they follow a merge.
- **Jira** (`ihrdcdev.atlassian.net`), with an API token in the Keychain: issues Jack created, each status change, each assignee change, other edits (by field name), and his comments. Changes by other people are left out.
- **Meetings**, from the Jax and IHRDC calendars through EventKit, once they have ended: each meeting's title, start, end, calendar and the number of other people invited. Each occurrence of a repeating meeting is its own item. All-day events, events marked Free, meetings Jack declined and meetings with no client are left out. Attendee addresses are used to choose the client and are not stored.
- **Recordings**, from Wispr Flow's database on the Mac (`~/Library/Application Support/Wispr Flow/flow.sqlite`, opened read-only), once they have ended: each recording's title, start, end and notes link. Its notes, summary and transcript are not read. Wispr Flow has no calendar connected, so a recording has no attendees; see "Recordings" under Clients for how it gets a client.
- **Sent email**, from the Sent mailbox of every Apple Mail account, through the same JXA script the contact linking job uses (`apple-mail.ts`), without the Inbox: each email's subject, the time it was sent and the number of people it went to. **The body is not read, and addresses are not stored**; the recipients' domains are used to choose the client. Email Jack sends from Outlook or Teams is not in Apple Mail and is not counted.
- **Claude Code**, from the session files in `~/.claude/projects`: when Jack worked, in which repo and branch, how many prompts he typed, and the short title Claude Code gives each session. **Prompts and replies are not stored.** A session is split into stretches of work wherever it was idle for more than 20 minutes, and each stretch into parts wherever it moved to another folder or branch. A stretch with no prompt from Jack is left out, because that is a background task or a long tool run, not Jack working. A part with no prompt of its own still counts when its stretch has one: until 2026-10-14 such parts were left out too, which dropped about 9.6 hours in the 7 days to 2026-10-14.

## Clients

Each item gets a client from where the work happened. The clients are MAISIE's task categories.

| Where | Client |
| --- | --- |
| Any repo in the IHRDC GitHub org, and the ihrdcdev Jira site | IHRDC |
| Any other repo in the Notarangelo-Technical-Advisory GitHub org, such as `nta-time-tracker`, `engineering-standards` and `fractional-tech-advisory` | NTA Business |
| `jax-assistant` (Maisie) | Executive Assistant |
| `solomon` | Solomon |
| `dora-tma` | DIAL |
| `Prophet-Priest-King` | PPK |
| `Grace-Pres`, `SNEP_SRT`, `bible-studies` | Church |
| `embassy-book-series` | Embassy Series |
| Everything else (Jack's personal repos under `jacknota`, such as `JaxPersonal`), and work outside any repo | General, unless its words name IHRDC (below) |

The table is `REPO_CLIENTS`, `OWNER_CLIENTS` and `JIRA_SITE_CLIENTS` in `functions/src/tools/journal.ts`. A Claude Code session in a scratch folder counts for the repo of the session that made the folder.

A Claude Code session often moves to a folder that is in no repo, such as `~/Documents/GitHub` (the folder above the repos) or Claude Code's own `memory` folder. Until 2026-10-15 that work had no repo and became General: 604 items, 27.7 hours, in the 30 days to 2026-10-15, most of it IHRDC. Now such a span takes, in order:

1. the repo the session was started in, from the folder Claude Code files the session under (`homeRepoOf` in `claude-sessions.ts`);
2. when that has no repo either, the repo that most of the session's activity was in.

Work that would still be General is given a client by its words. It is IHRDC when its title, action, detail or ticket names an IHRDC Jira key (CNG, THREEX or ITSP, in any case) or the words "Jira", "Aishwarya", "QA test agent", "QA testing agent" or "Bug fixer agent". It is Church for "Bible study", "Bible studies" or "Ecclesiastes". The words are `TEXT_CLIENTS` in `functions/src/tools/journal.ts`. Work in a repo with its own client keeps it: a Maisie session about a Jira token stays Executive Assistant.

What is left in General is mostly personal work in `JaxPersonal`, such as a job search or a letter about a traffic ticket. It is General on purpose, because it is not for a client. If Jack wants it counted, add a task category and map the repo to it in `REPO_CLIENTS`.

A client can be any task category, including one Jack added, such as Executive Assistant (`executive_assistant`); the journal shows it by its name.

After changing `REPO_CLIENTS`, `OWNER_CLIENTS` or `TEXT_CLIENTS`, move the GitHub and Claude Code items already in the journal from the Mac, once the change is on `main`. The command also reads Claude Code's session files again (the last 90 days, though Claude Code keeps about a month), so that a stored item with no repo gets the one its session now gives it:

```bash
cd functions
npm run journal:reclassify -- --dry-run   # what would move
npm run journal:reclassify                # move it and rebuild the days
```

Jira items, meetings, recordings and emails keep their client, because their rules need what the job read at the time.

When the rules give an item the wrong client, for example IHRDC work kept in the NTA repo because it was sensitive, Jack moves it on the journal page: tick the items (one at a time, a whole work session from its heading, or Select all), choose a client under "Move to" and press Move. The `journalItems` Cloud Function sets the client, marks the item `clientByHand: true` and rebuilds the day. The journal job and `journal:reclassify` never change the client of an item marked that way; the reclassify command says how many it kept.

Jack can also ask MAISIE, in the chat or in VS Code: "move the IHRDC work under NTA Business on October 27 to IHRDC". She finds the items with `get_journal`, which gives each item's `id` and marks moved items `movedByHand`, and moves them with `move_journal_items`, the same code the page uses. When she chose the items herself from his description, she lists them and asks before moving.

NTA Business (`nta`) is a built-in task category, added 2026-10-16. Work in those repos that was journaled before then is still under General until `npm run journal:reclassify` is run on the Mac.

### Meetings

A meeting gets its client from the first of these that applies. A meeting that matches none is left out, so personal events on the Jax calendar are not counted.

| Rule | Client |
| --- | --- |
| Someone invited has an `ihrdc.com` address | IHRDC |
| Someone invited has a `coxeng.com` address | Cox Engineering |
| On the IHRDC calendar, with at least one other person invited. A block with nobody else invited, such as "Norma Dr Appt", is left out | IHRDC |
| The title has the word "Cox" | Cox Engineering |
| The title has "Officer Meeting", "Grace Prayer Meeting", "Community Group", "Praying Avidly" or "Worship" | Church |

Words match whole words, ignoring case and punctuation, so "Cox" does not match "Coxswain". The rules are `DOMAIN_CLIENTS`, `CALENDAR_CLIENTS` and `MEETING_WORDS` in `functions/src/tools/journal.ts`. A new rule applies to meetings read after it is deployed. To apply it to the last 30 days, delete the `meetingsCheckedThrough` field of `metadata/journal`, and the next run reads the calendars from 30 days back.

### Recordings

A Wispr Flow recording gets its client from the first of these that applies. A recording that matches none is left out, and the job's log counts it.

| Rule | Example |
| --- | --- |
| The calendar meeting it overlaps most, among the meetings the journal counts | "Phase Two Improvements Plan" during Product Review Meeting → IHRDC |
| A word from the meeting word list in its title | "Cox Engineering: Discovery Roadmap Review" → Cox Engineering |
| A Jira key from CNG, THREEX or ITSP in its title | "Approving CNG-6882 Map" → IHRDC |

The Jira projects are `JIRA_PROJECT_CLIENTS` in `functions/src/tools/journal.ts`: the IHRDC projects Jack's Jira, GitHub and Claude Code work used in the 30 days to 2026-10-14. Other keys are ignored, because a title can hold look-alikes such as UTF-8. In the 30 days to 2026-10-14, 13 of 19 recordings got a client; the 6 left out (2 h 19 min) included four IHRDC calls that were not on the calendar.

### Sent email

A sent email gets its client from the first of these that applies. An email that matches none is left out, so personal email is not counted, and the job's log counts it.

| Rule | Example |
| --- | --- |
| Someone in To or Cc has a domain in `DOMAIN_CLIENTS`. Jack's own addresses (those of his Mail accounts) are ignored | To brad@ihrdc.com → IHRDC, "To ihrdc.com" |
| A Jira key from CNG, THREEX or ITSP in the subject | "Re: CNG-7039 grid layout" → IHRDC |
| A word from the meeting word list or `TEXT_CLIENTS` in the subject | "Officer Meeting agenda" → Church |

The rules are `emailItems` in `functions/src/tools/journal.ts`.

## How time is estimated

- Items of one client less than 20 minutes apart form one work session, timed from the first item to the last.
- A session is never shorter than 6 minutes (0.1 hour, the billing step).
- A Claude Code item covers its own start to end. A meeting covers its scheduled start to end, because the calendar cannot tell whether it ended early or late.
- A sent email is a moment: on its own it counts for 6 minutes, and an email less than 20 minutes from other work for the same client joins that work's session.
- A recording covers the time it was recording, beside its calendar meeting, never instead of it: Jack sometimes records only part of a meeting. Time recorded before or after the scheduled meeting is added, and the overlap counts once.
- Each client's time is counted on its own. The day total counts overlapping work once, so client times can add up to more than the day total.
- These are estimates to help fill in time entries. They are not logged time.

## Timeline

The Timeline button on the `/journal` page shows the chosen dates as one line a day, oldest first, from 6 AM (or earlier, when there was earlier work) to midnight in Eastern Time. Days with no work are shown too. It is for seeing when Jack was not working, so that he keeps long breaks in his day.

- Each work session is a block in its client's colour. With one client chosen, other clients' work is grey, so it is not taken for a break.
- A break is a gap of more than 20 minutes with no work for any client, the same gap that ends a work session. Breaks are outlined, and a break of an hour or more shows its length.
- Jack's rhythm: weekday mornings until noon are his work time. The rest of a weekday, and all of a weekend, he keeps free for family and personal tasks. His problem is many short pieces of work scattered through the afternoon and evening, which make a day feel like work all day.
- The free time is shaded on each line, and the part of any work that falls in it has a red line under it.
- Above the lines, a bar and three figures show the size of the problem over the chosen dates: weekday mornings, weekday afternoons and evenings (in hours and pieces, and on how many weekdays), and weekends.
- A piece is a stretch of work with no break of more than 20 minutes. Overlapping work for two clients counts once.
- On the right of each line are the hours worked, the work in free time ("1.9 h · 4" is 1.9 hours in 4 pieces), and the day's longest break. "None" means no work in free time, or no break of more than 20 minutes. On a phone the longest break is hidden.
- Clicking a day opens its details in the list.
- It shows 62 days at most.

`get_journal` gives MAISIE each day's `workedFrom`, `workedTo`, `breaks`, `longestBreakHours`, `weekend`, `morningHours`, `freeTimeHours` and `freeTimePieces`, worked out in the same way (`dayBreaks` and `dayRhythm` in `functions/src/tools/journal.ts`), so she can answer "How much did I work in my free time this week?" and point out the days and the pattern behind them. The breaks always count every client's work, even when one client is asked for.

The page and the tool each have their own copy of the break and rhythm rules: `timeline.ts` beside the page (`BREAK_MINUTES`, `WORK_TIME_END`), and `dayBreaks` and `dayRhythm` in the functions (`GAP_MINUTES`, `WORK_TIME_END_HOUR`). Change both together.

## Where everything is

- **Firestore:** `journal` (one document per item, with a fixed id from its source, so a second run adds nothing) and `journalDays` (one summary per day, rebuilt when the day's items change). The job's progress is in `metadata/journal`. The page can only read them; only the job writes.
- **Rules and the tool:** `functions/src/tools/journal.ts`.
- **Job and readers (Mac only):** `functions/src/mcp/collect-journal.ts`, with `github-activity.ts`, `jira-activity.ts`, `claude-sessions.ts` and `apple-meetings.ts` beside it. `apple-meetings.ts` and `apple-mail.ts` are shared with automatic contact linking. `wispr-recordings.ts` reads Wispr Flow. launchd runs it from `bridge/com.notarangelo.work-journal.plist`; the log is `/tmp/work-journal.log`.
- **Web page:** `src/app/components/journal/`, with `JournalService` in `src/app/services/journal.service.ts`. The timeline's rules are in `timeline.ts` there.
- **Tests:** `tests/functions/journal.test.mjs`, `tests/mcp/journal.test.mjs`, the journal tests in `tests/rules/firestore.test.mjs` and `tests/mcp/maisie-server.test.mjs`, and `journal.component.spec.ts`.

## Setting it up on Jack's Mac

1. Merge the pull request, so the page, the rules and the index are deployed.
2. Add the Jira token once:
   - Create a token at https://id.atlassian.com/manage-profile/security/api-tokens with **Create API token with scopes**. Name it "Maisie work journal", choose the longest expiry, choose the app Jira, and choose the scopes `read:jira-work` and `read:jira-user`. This token can only read. A token without scopes also works, but it can do anything Jack can do in Atlassian.
   - A token with scopes works only through Atlassian's gateway, `api.atlassian.com/ex/jira/<cloud id>`. The reader tries the gateway first and then the site's own address, so either kind of token works.
   - Run `security add-generic-password -s maisie-jira -a jnotarangelo@ihrdc.com -w` and paste the token when asked.
3. Run `cd functions && npm run journal:collect -- --dry-run` to see what would be added, then `npm run journal:collect` for the first run. It looks back 30 days for Jira and Claude Code and takes a few minutes. GitHub keeps only Jack's last 300 events, which at his current pace is about 3 days, so the GitHub part of the journal starts there.
4. Mail needs Automation access for the process that runs the job, under System Settings > Privacy & Security > Automation. The contact linking job already has it; if the first run says Mail refused, allow it there.
5. Install the job:
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
- Add Teams messages and calls through the Microsoft 365 connector, and email sent from Outlook, which Apple Mail does not see.
- Record which app is open on the Mac each minute, to count time spent in Word, Excel, Visual Studio and the browser.
- Add phone and FaceTime calls, which the contact linking job already reads. A call's client would come from the contact's company.
- Give the recordings left out a client by asking Claude to choose one from Wispr Flow's summary, through a Cloud Function. Or connect the IHRDC calendar in Wispr Flow, so each recording carries its calendar event and attendees.
- If the Mac is off for more than about 3 days, GitHub's feed drops the oldest events. GitHub's search API could fill that gap for pull requests and reviews.
