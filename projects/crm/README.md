# CRM and Address Book

MAISIE keeps Jack's contacts, companies, notes and links to emails, meetings and web pages. Jack can use them on the web page, in the MAISIE chat, and from VS Code or any other MCP client through the `maisie` MCP server.

*Last updated: 2026-10-06*

## Status

| Phase | What it adds | Estimate | Status |
| --- | --- | --- | --- |
| 1 | Contacts, companies and notes, with tools, MCP access and the `/contacts` page | 20–30 hours | **Live** since 2026-10-06 (run #127) |
| 2 | Links from contacts and companies to emails, meetings and web pages | 8–12 hours | **Live** since 2026-10-06 (run #128) |
| 3 | One-way import from Apple Contacts, of everyone | 6–10 hours | **Built** 2026-10-06. First real run needs Jack's Mac. |
| 4 | Automatic linking of emails and meetings to contacts | 15 hours or more | Not started |
| Optional | Remote MCP server, for claude.ai and phone access | 10–15 hours | Not planned |

## Decisions that shape the design

- **MAISIE holds the only copy of CRM data.** There is no two-way sync with Apple Contacts or Outlook. Two-way sync would carry most of the risk and effort, and none of Jack's goals need it.
- **Email address identifies a person.** A second contact with an address already on file is refused, by the tools and by the web page.
- **Company names are not copied onto contacts.** Each contact stores `companyId`, and the name is looked up when read, so a rename changes it everywhere.
- **Links are self-contained.** Each link keeps its own title, date, and sender or calendar, because the calendar mirror deletes past events and Mail is reachable only from Jack's Mac.
- **Only http and https addresses are stored or opened**, so a link cannot run script.
- **The MCP server stays local over stdio.** It works in VS Code, Claude Desktop and Cursor on Jack's Mac.

Full reasoning for each decision is in `decisions/log.md` (entries dated 2026-10-06).

## Where everything is

- **Firestore collections:** `contacts`, `companies`, `contactNotes`, `contactLinks`. Rules are in `firestore.rules`.
- **Tool code:** `functions/src/tools/contacts.ts`. The cloud chat function and the MCP server share it through `execute.ts`.
- **Tools:** `find_contacts`, `get_contact`, `get_company`, `save_contact`, `save_company`, `add_contact_note`, `link_to_contact`, `remove_contact_link`, and `import_apple_contacts` in VS Code only.
- **Apple Contacts import:** the macOS reader is `functions/src/mcp/apple-contacts.ts`; the merge rules are `functions/src/tools/contacts-import.ts`.
- **Web page:** `src/app/components/contacts/`, with `ContactService` in `src/app/services/contact.service.ts`.
- **Tests:** `tests/rules/`, `tests/functions/`, `tests/mcp/` and `contacts.component.spec.ts`. See the Tests section of `README.md`.

## How Jack uses it

- **Web page:** the people icon in the dashboard header opens `/contacts`. Search, add, edit and delete contacts, add notes, and add web pages or meetings as links. Emails open in Apple Mail on the Mac.
- **Chat or VS Code:** for example, "Who do I know at IHRDC?", "Add a note to Brad: prefers Teams to email", or "Link Brad's email about the Friday demo to him".
- **Only the web page can delete** contacts and notes. MAISIE cannot, so nothing is lost by accident.

## Phase 3: import from Apple Contacts (built)

- **What it does:** copies everyone in Apple Contacts into MAISIE. It never writes back to Apple Contacts. Jack chose to import everyone, not chosen groups.
- **How to run it:** in VS Code, ask "import my Apple contacts" (a dry run comes first), or in a terminal run `cd functions && npm run import:contacts -- --dry-run`, then without `--dry-run`.
- **Matching:** by the Apple card from an earlier import, then by email, then by an exact name that only one contact has. Otherwise a new contact is created.
- **Never loses Jack's work:** fills blank fields only, adds new email addresses and phone numbers, never removes anything, and leaves notes and links alone. An email already on another contact stays with that contact.
- **Company cards** become companies. Cards with no name and no company are skipped.
- **Needs from Jack:** his Mac, and permission for Terminal or VS Code to read Contacts the first time it runs.
- **First real run:** do the dry run, check the counts and example names, then import.
- **First dry run (2026-10-06):** 1,217 cards read; 1,147 new contacts, 10 updated, 26 already up to date, 28 company cards, 6 skipped, 282 new companies. It first read 0 cards, because macOS 26 lists no contact accounts; the reader now reads all contacts in one request when that happens.

## Phase 4: automatic linking (later)

- Attach new emails and meetings to a contact automatically, matched by sender or attendee address.
- Phase 3 is built, so most people will have their email addresses on file once Jack runs the import.
