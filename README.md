# JaxAssistantApp — MAISIE

MAISIE is Jack's executive assistant. She runs on three surfaces:

| Surface | Reaches | Notes |
| --- | --- | --- |
| Web dashboard + SMS | Firestore state, NTA time tracker, and the desktop via a queue | The `chat` Cloud Function, Anthropic tool loop |
| Scheduled briefings | Same, unattended | `morningBriefing` (7am/1pm ET), `invoiceReminder` |
| VS Code (Claude Code) | Everything above **plus** native Apple Mail and Calendar | Two local MCP servers |

## MAISIE in VS Code

Two stdio MCP servers expose MAISIE to Claude Code. Both are local-only and are
never deployed — their SDKs are devDependencies, which the Cloud Functions
runtime does not install.

| Server | Path | Tools |
| --- | --- | --- |
| `maisie` | `functions/src/mcp/server.ts` | `add_task`, `complete_task`, `reopen_task`, `update_task`, `create_task_category`, `delete_task_category`, `get_unbilled_detail`, `get_time_entries`, `get_invoice_status`, `add_time_entries`, `delete_time_entry`, `get_journal`, `save_memory`, `get_memories`, `forget_memory`, `find_contacts`, `get_contact`, `get_company`, `save_contact`, `save_company`, `add_contact_note`, `link_to_contact`, `remove_contact_link`, `get_maisie_context`, `import_apple_contacts` (VS Code only) — plus a `maisie` prompt that loads her persona and current state |
| `desktop` | `bridge/mcp/desktop-server.ts` | `calendar_read`, `calendar_create`, `calendar_move`, `mail_search`, `mail_read`, `mail_draft`, `mail_send` |

Tool implementations are shared, not duplicated: `functions/src/tools/`
(definitions + executor + context) backs both the cloud `chat` function and the
`maisie` server, and `bridge/applescript/` backs the `desktop` server,
`calendar-sync.ts`, and `desktop-bridge.ts`.

Calendar **reads** are the exception: they live in `bridge/eventkit/` and go
through EventKit, not AppleScript. Calendar.app's scripting dictionary cannot
expand a recurring series — a weekly meeting is one object whose `start date` is
its first occurrence, so a windowed query silently dropped every standing
meeting on every calendar. Writes stay on AppleScript. The two use different
macOS permissions; see "Permissions" below.

MAISIE's four other cloud tools are deliberately absent from VS Code:
`get_calendar` / `create_calendar_event` / `move_calendar_event` because
AppleScript reads fresher and writes instantly; `code_with_github` because in
VS Code you are already in the repo.

### Setup

`.mcp.json` is gitignored — it holds absolute paths to this checkout. Create it
at the repo root:

```json
{
  "mcpServers": {
    "maisie": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "<repo>/functions"
    },
    "desktop": {
      "command": "npx",
      "args": ["tsx", "mcp/desktop-server.ts"],
      "cwd": "<repo>/bridge"
    }
  }
}
```

Then:

1. Put a Firebase service account key at `bridge/service-account.json`
   (gitignored — Firebase Console > Project Settings > Service Accounts). Both
   servers use it; the `maisie` server also exports it as
   `GOOGLE_APPLICATION_CREDENTIALS` so the cross-project read of the NTA time
   tracker (`fta-invoice-tracking`) resolves.
2. Grant macOS automation permission for Mail and Calendar — run
   `cd bridge && npm run mcp:desktop` once from a terminal and accept the
   prompts.
3. Grant EventKit **Full Access to Calendars** (see "Permissions").
4. Restart Claude Code and check `/mcp`.

### Permissions

Calendar work needs two separate TCC grants, and they are easy to confuse:

| Grant | Where | Used by |
| --- | --- | --- |
| Automation → Calendar | Privacy & Security > Automation | `calendar_create`, `calendar_move`, all Mail tools |
| Full Access to Calendars | Privacy & Security > Calendars | every calendar read |

Both are attributed to the *responsible process* — the terminal, VS Code, or the
launchd agent — so granting it in one place does not cover the others. Grant it
by running the relevant entry point once from a terminal.

A process holding only **write-only** calendar access sees exactly one calendar
and returns no error, which looks identical to a quiet week. So the reader
refuses to interpret that as data: it raises `CalendarReadError`, the MCP tool
returns an explicit read failure, and `calendar-sync` skips the run and leaves
the previous Firestore contents alone rather than deleting a mirror it could not
verify. `EKAuthorizationStatus 4` in `/tmp/calendar-sync.log` means exactly this.

Run either server by hand to debug: `cd functions && npm run mcp`, or
`cd bridge && npm run mcp:desktop`. Both log to stderr; stdout is the protocol.

### Importing Apple Contacts

Copies everyone in Jack's iCloud contacts into MAISIE's contacts; cards from
other accounts on the Mac, such as Google, are left out. Apple Contacts is never
changed. iCloud is the master copy of each person's name, title, company, emails
and phones, and a contact whose iCloud card is gone is removed unless it has
notes or hand-made links. See Phase 3 in `projects/crm/README.md`. It runs every
morning at 6:00:

```bash
cp bridge/com.notarangelo.contacts-import.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.notarangelo.contacts-import.plist
```

- **From VS Code:** ask "import my Apple contacts". The `import_apple_contacts`
  tool does a dry run first and shows the counts; it imports only when told to.
- **From a terminal:** `cd functions && npm run import:contacts -- --dry-run`,
  then `npm run import:contacts` to import.
- **First run:** macOS asks to allow Contacts access for Terminal or VS Code.
  If it was refused, allow it under System Settings > Privacy & Security >
  Contacts and run it again.

## Desktop bridge (cloud → Mac)

`bridge/desktop-bridge.ts` polls the `pendingDesktopActions` collection every
30s via launchd and executes queued Mail/Calendar actions on this Mac, writing
results back. That is what lets the web app and SMS reach the desktop — the
cloud `mail_search` / `mail_read` / `mail_draft` tools enqueue an action and
wait up to 40s for the result.

There is no `mail_send` from the cloud by design: MAISIE can compose a draft,
but sending only happens from VS Code where you can see it.

```bash
cp bridge/com.notarangelo.desktop-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.notarangelo.desktop-bridge.plist
# it replaces the coding bridge:
launchctl unload ~/Library/LaunchAgents/com.notarangelo.coding-bridge.plist
```

Watch the queue with `cd bridge && npm run queue`.

## Automatic contact linking (Mac)

`functions/src/mcp/autolink-contacts.ts` runs every 15 minutes via launchd and
ties new emails, meetings, text messages and calls to CRM contacts. See Phase 4 in
`projects/crm/README.md`.

```bash
cp bridge/com.notarangelo.contact-autolink.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.notarangelo.contact-autolink.plist
```

The log is `/tmp/contact-autolink.log`.

**Text messages** come from the Mac's Messages database
(`~/Library/Messages/chat.db`), read-only, so Messages in iCloud must be on
for the Mac to have the iPhone's texts. Each contact gets one link per day:
the first line of the day's first message (at most 80 characters) and the
number of messages. Nothing else of a conversation is stored. macOS protects
that database, so the job needs Full Disk Access once:

1. Open System Settings > Privacy & Security > Full Disk Access.
2. Click **+**, press Cmd+Shift+G, type `/opt/homebrew/bin/node` and add it.
3. Turn it on. If the log still says "Cannot open the Messages database", add
   `/usr/bin/sqlite3` the same way.

Until then, the log reports that error every run, and emails and meetings are
still linked.

**Calls** come from the Mac's call history
(`~/Library/Application Support/CallHistoryDB/CallHistory.storedata`),
read-only. The iPhone shares its phone and FaceTime calls with the Mac through
iCloud; the Phone app's Recents on the Mac shows whether it does. Each call is
one link: when it started, whether it was incoming or outgoing, phone or
FaceTime, and how long it lasted. Missed calls are never linked. The same Full Disk Access grant as
Messages covers it. If the log says "Cannot open the call history", follow the
steps above.

Calendar writes from the cloud still flow through the older
`pendingCalendarActions` queue, which `calendar-sync.ts` applies on its own
schedule. `desktop-bridge.ts` understands `calendar.*` actions too, so that path
can migrate later without adding another queue.

## Memory

Jack can give MAISIE a standing instruction once and she follows it in every
later conversation, in the web chat and in VS Code. For example: "Maisie,
remember how I want invoice descriptions written: ..." She saves it with
`save_memory` under a short topic in the `memories` collection. Saving the same
topic again replaces the instruction. `get_memories` lists them and
`forget_memory` removes one.

Every memory is added to the state block of each chat request and to the
`maisie` MCP prompt and `get_maisie_context`, so she does not have to look them
up. To keep each request small, she holds at most 50 topics of at most 4,000
characters each. Only MAISIE writes memories (Admin SDK); the web app can read
them.

## Posting time to the time tracker

Time from the work journal is posted to the NTA time tracker (Firestore
project `fta-invoice-tracking`) in two ways. Both use the same checks.

- **Journal page (the main way).** Choose a client's day and click "Post to
  time tracker" to open the panel (click again to close it). It lists each work session as an entry with its exact start and
  end, shows what is already in the tracker that day, and unticks any session
  whose time is already logged. "Draft descriptions" asks MAISIE to write each
  line in Jack's saved style for invoice descriptions; Jack edits the times and
  text, then presses Post. The page calls the `timeEntries` Cloud Function
  (`functions/src/time-entries-action.ts`), with the actions `day`, `draft`
  and `post`. Drafts use `MODEL` with structured output.
- **Chat.** Jack says, for example, "post yesterday's IHRDC time". MAISIE
  proposes the entries, shows him the list, and posts only after he says yes.

- `add_time_entries` (used by both) checks every entry first and posts all of them or none. A
  future date, an unknown or inactive customer or project, or an overlap with an entry already in the tracker
  refuses the whole request. It previews (`dry_run`) unless told otherwise.
- Times are to the minute, because Jack bills to the minute. Hours are end
  minus start to two decimals, as the tracker works them out.
- Entries are written in the shape the tracker's own form writes, as
  `unbilled`, plus `source: "maisie"`.
- `delete_time_entry` removes only an unbilled entry that MAISIE posted.

The service account that runs the Cloud Functions, and the one in
`bridge/service-account.json` for VS Code, need the role **Cloud Datastore
User** (`roles/datastore.user`) in the `fta-invoice-tracking` project. With
read access only, MAISIE says the tracker refused the write and names this
role.

## Work journal (Mac)

`functions/src/mcp/collect-journal.ts` runs every 15 minutes via launchd and
records what Jack did, when, and for which client: pull requests, reviews,
comments and pushes on GitHub; issues he created, moved, edited or commented on
in IHRDC's Jira; when he worked in Claude Code, in which repo and branch;
meetings on his Jax and IHRDC calendars, once they have ended; meetings he
recorded in Wispr Flow that can be tied to a client; and emails he sent from
Apple Mail to a client (subject and recipients' domain only, never the body). The `/journal` page (book icon in the dashboard header) shows estimated hours
per week, day and client, and each client's work sessions and items. It opens
on the last 14 days; filters choose other dates and one client or all clients. MAISIE
reads it with `get_journal`. After a change to which repo belongs to which
client, `npm run journal:reclassify` (from `functions/`) moves the items already
stored. See `projects/work-journal/README.md`.

```bash
cp bridge/com.notarangelo.work-journal.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.notarangelo.work-journal.plist
```

The log is `/tmp/work-journal.log`. Jira needs an API token in the Keychain
once; until then the log reports a Jira error and the other sources are still
collected:

1. Create a token at https://id.atlassian.com/manage-profile/security/api-tokens
   with **Create API token with scopes**: app Jira, scopes `read:jira-work` and
   `read:jira-user`. A token without scopes also works.
2. Run `security add-generic-password -s maisie-jira -a jnotarangelo@ihrdc.com -w`
   and paste the token when asked.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Tests

The tests follow the testing trophy used in Solomon: most of the weight is on
integration tests that run against the Firebase emulators with the real
security rules, with type-checking underneath and one end-to-end test on top.
Nothing touches live data: each suite runs under its own `demo-` project.

| Command | What it covers | Where |
| --- | --- | --- |
| `npm run test:ci` | The contacts page, the journal page and their services in headless Chrome, signed in against the Auth and Firestore emulators | `src/**/*.spec.ts` |
| `npm run test:site` | The browser tab and phone home-screen icons exist at the sizes `src/index.html` declares, the dashboard header logo exists and draws without a web font, the header logo and phone-only call button are named for screen readers, the call button sits just left of the speaker button, the main area fills the page until Maisie is called, and on a phone the contacts page shows a contact in place of the list | `tests/site/` |
| `npm run test:rules` | Firestore security rules, using the same queries the web app makes | `tests/rules/` |
| `npm run test:functions` | MAISIE's tools through `executeTool()`, the entry point shared by the chat function and the MCP server, how the Headlines tab gathers stories, and the work journal's clients and time estimates | `tests/functions/` |
| `npm run test:mcp` | The `maisie` MCP server started as VS Code starts it, driven by the official MCP client, the automatic contact linking job run with Mail and Calendar output from fixture files, and the work journal job run with saved GitHub, Jira, Calendar, Mail and Wispr Flow answers and sample Claude Code session files, and how the Jira reader signs in with either kind of token | `tests/mcp/` |
| `npm run test:bridge` | The AppleScript the desktop bridge runs to create and move Apple Calendar events: a 1 PM event lands at 1 PM on a 12-hour-clock Mac, and a bad or zero-length time is refused. The tests that run AppleScript are skipped outside macOS, and none of them touch the real calendar | `bridge/tests/` |
| `npm run test:all` | All six, in that order | |

`npm test` runs the browser tests in watch mode. The suites need the Firebase
CLI (`npm install -g firebase-tools`) and Java 21 for the Firestore emulator.

The `Tests` workflow runs every suite on each pull request, and
`deploy-and-release.yml` will not build or deploy until it passes.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
