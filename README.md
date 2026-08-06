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
| `maisie` | `functions/src/mcp/server.ts` | `add_task`, `complete_task`, `reopen_task`, `update_task`, `create_task_category`, `delete_task_category`, `get_unbilled_detail`, `get_time_entries`, `get_invoice_status`, `get_maisie_context` — plus a `maisie` prompt that loads her persona and current state |
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

Calendar writes from the cloud still flow through the older
`pendingCalendarActions` queue, which `calendar-sync.ts` applies on its own
schedule. `desktop-bridge.ts` understands `calendar.*` actions too, so that path
can migrate later without adding another queue.

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

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
