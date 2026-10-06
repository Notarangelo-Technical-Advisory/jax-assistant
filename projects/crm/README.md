# CRM and Address Book

MAISIE keeps Jack's contacts, companies, notes and links to emails, meetings and web pages. Jack can use them on the web page, in the MAISIE chat, and from VS Code or any other MCP client through the `maisie` MCP server.

*Last updated: 2026-10-06*

## Status

| Phase | What it adds | Estimate | Status |
| --- | --- | --- | --- |
| 1 | Contacts, companies and notes, with tools, MCP access and the `/contacts` page | 20–30 hours | **Live** since 2026-10-06 (run #127) |
| 2 | Links from contacts and companies to emails, meetings and web pages | 8–12 hours | **Live** since 2026-10-06 (run #128) |
| 3 | One-way import from Apple Contacts | 6–10 hours | Not started. Jack will decide when to start. |
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
- **Tools:** `find_contacts`, `get_contact`, `get_company`, `save_contact`, `save_company`, `add_contact_note`, `link_to_contact`, `remove_contact_link`.
- **Web page:** `src/app/components/contacts/`, with `ContactService` in `src/app/services/contact.service.ts`.
- **Tests:** `tests/rules/`, `tests/functions/`, `tests/mcp/` and `contacts.component.spec.ts`. See the Tests section of `README.md`.

## How Jack uses it

- **Web page:** the people icon in the dashboard header opens `/contacts`. Search, add, edit and delete contacts, add notes, and add web pages or meetings as links. Emails open in Apple Mail on the Mac.
- **Chat or VS Code:** for example, "Who do I know at IHRDC?", "Add a note to Brad: prefers Teams to email", or "Link Brad's email about the Friday demo to him".
- **Only the web page can delete** contacts and notes. MAISIE cannot, so nothing is lost by accident.

## Phase 3: import from Apple Contacts (next)

- **What it does:** copies people from Apple Contacts into MAISIE once, or again on request. It never writes back to Apple Contacts.
- **How:** a bridge script on Jack's Mac reads Contacts through `CNContactStore`, in the same way the calendar reader uses EventKit.
- **Matching:** by email address. A person already in MAISIE is updated, not duplicated, and notes and links are kept.
- **Needs from Jack:** his Mac awake, and permission for the bridge to read Contacts the first time it runs.
- **Open question for Jack:** import everyone, or only contacts in chosen Apple Contacts groups?

## Phase 4: automatic linking (later)

- Attach new emails and meetings to a contact automatically, matched by sender or attendee address.
- Needs Phase 3 first, so that most people already have their email addresses on file.
