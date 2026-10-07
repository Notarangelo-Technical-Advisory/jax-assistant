# CRM and Address Book

MAISIE keeps Jack's contacts, companies, notes and links to emails, meetings and web pages. Jack can use them on the web page, in the MAISIE chat, and from VS Code or any other MCP client through the `maisie` MCP server.

*Last updated: 2026-10-06*

## Status

| Phase | What it adds | Estimate | Status |
| --- | --- | --- | --- |
| 1 | Contacts, companies and notes, with tools, MCP access and the `/contacts` page | 20–30 hours | **Live** since 2026-10-06 (run #127) |
| 2 | Links from contacts and companies to emails, meetings and web pages | 8–12 hours | **Live** since 2026-10-06 (run #128) |
| 3 | One-way import from Apple Contacts, of everyone in iCloud | 6–10 hours | **Live** since 2026-10-06 (293 contacts, 56 companies after the iCloud-only clean-up) |
| 4 | Automatic linking of emails and meetings to contacts | 15 hours or more | **Live** since 2026-10-06 (first run: 370 links) |
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

- **Firestore collections:** `contacts`, `companies`, `contactNotes`, `contactLinks`, `contactLinkDismissals` (automatic links Jack removed). The linking job's progress is in `metadata/contactAutoLink`. Rules are in `firestore.rules`.
- **Tool code:** `functions/src/tools/contacts.ts`. The cloud chat function and the MCP server share it through `execute.ts`.
- **Tools:** `find_contacts`, `get_contact`, `get_company`, `save_contact`, `save_company`, `add_contact_note`, `link_to_contact`, `remove_contact_link`, and `import_apple_contacts` in VS Code only.
- **Apple Contacts import:** the macOS reader is `functions/src/mcp/apple-contacts.ts`; the merge rules are `functions/src/tools/contacts-import.ts`.
- **Automatic linking:** the job is `functions/src/mcp/autolink-contacts.ts`, with readers `apple-mail.ts` and `apple-meetings.ts` beside it; the rules are `functions/src/tools/contact-autolink.ts`; launchd runs it from `bridge/com.notarangelo.contact-autolink.plist`.
- **Web page:** `src/app/components/contacts/`, with `ContactService` in `src/app/services/contact.service.ts`.
- **Tests:** `tests/rules/`, `tests/functions/`, `tests/mcp/` and `contacts.component.spec.ts`. See the Tests section of `README.md`.

## How Jack uses it

- **Web page:** the people icon in the dashboard header opens `/contacts`. Search, add, edit and delete contacts, add notes, and add web pages or meetings as links. Emails open in Apple Mail on the Mac. A contact from iCloud shows "From iCloud": only its tags can be edited here, and it is deleted in iCloud.
- **Chat or VS Code:** for example, "Who do I know at IHRDC?", "Add a note to Brad: prefers Teams to email", or "Link Brad's email about the Friday demo to him".
- **Only the web page can delete** contacts and notes. MAISIE cannot, so nothing is lost by accident.
- **iCloud is the master copy** of the name, title, company, emails and phones of every contact that came from iCloud. Jack changes them in Contacts on his Mac or phone; MAISIE picks them up in the 6:00 import. Tags, notes and links exist only in MAISIE.

## Phase 3: import from Apple Contacts (live)

- **What it does:** copies everyone in Jack's iCloud contacts into MAISIE, every morning at 6:00 (`bridge/com.notarangelo.contacts-import.plist`, log `/tmp/contacts-import.log`, last result in `metadata/contactImport`). It never writes back to Apple Contacts. Jack chose everyone, not chosen groups, and iCloud only: the Mac also syncs 976 Google cards, which are left out and counted.
- **How to run it by hand:** in VS Code, ask "import my Apple contacts" (a dry run comes first), or in a terminal run `cd functions && npm run import:contacts -- --dry-run`, then without `--dry-run`.
- **Matching:** by the Apple card from an earlier import, then by email, then by an exact name that only one contact has. Otherwise a new contact is created.
- **iCloud wins (since 2026-10-06, Jack's choice):** the name, title, company, emails and phones of a contact from iCloud are replaced with the card's, including a field cleared in iCloud. Tags, notes and links are never touched. An email already on another contact stays with that contact. When two iCloud cards are the same person, the second only adds to the first.
- **Card deleted in iCloud:** the contact is removed with its automatic links, unless it has notes or hand-made links. Then it is kept, shown as "No longer in iCloud", and becomes a normal MAISIE contact that can be edited and deleted on the page. If the person comes back to iCloud, the contact is tied to the new card again.
- **Safety:** if a run finds no iCloud cards, or would remove more than 20% of the contacts from iCloud (at least 10), it removes nothing and reports `removalsHeld`. The morning job then ends with an error in its log. Check with `--dry-run`, then run `npm run import:contacts -- --allow-many-removals`.
- **Contacts made in MAISIE** are never removed. If one shares an email or a unique name with an iCloud card, it is tied to that card and iCloud owns its details from then on.
- **Company cards** become companies. Cards with no name and no company are skipped.
- **Needs from Jack:** his Mac, and permission for Terminal or VS Code to read Contacts the first time it runs.
- **First import (2026-10-06):** dry run first, then the real import through the `maisie` MCP server. 1,217 cards read; 1,147 new contacts, 10 updated, 26 already up to date, 28 company cards, 6 skipped, 282 new companies. It first read 0 cards, because macOS 26 lists no contact accounts; the reader now reads all contacts in one request when that happens.
- **iCloud only (2026-10-06):** the first import read every account, so 853 Google cards (and 1 On My Mac card) became contacts, including a second Brad Donohue. Jack chose iCloud only. A one-off clean-up removed those 854 contacts, 2 automatic links and 235 companies no one used, and pointed 82 kept contacts at their iCloud card. The reader now reads each card on its own, with its account, rather than cards merged across accounts. Result: 293 contacts and 56 companies, matching iCloud.

## Phase 4: automatic linking (live)

- **What it does:** every 15 minutes, ties new emails and meetings to the contacts taking part in them, matched by email address. Links show on the contact's page as "linked automatically", and MAISIE sees them in `get_contact`.
- **Emails:** received and sent, from the Inbox and Sent mailbox of every Mail account. Sender, To and Cc are matched.
- **Meetings:** the Jax and IHRDC calendars only (Jack's choice), once a meeting has started, so one cancelled beforehand is never linked. Attendees and the organizer are matched; rooms are not.
- **History:** the first run looks back 30 days. Each later run starts an hour before the previous one finished.
- **Never matched:** Jack's own addresses, read from his Mail accounts, so his own contact card does not collect everything.
- **Skipped:** emails and meetings with more than 15 other people, such as all-hands meetings and mailings, and emails from automated senders such as `no-reply@`, `notifications@` and `alerts@` (added 2026-10-06 after Thoropass alerts were linked to Brad Donohue).
- **No repeats:** an item already linked to that contact, by hand or by an earlier run, is not linked again.
- **Removing a link:** on the web page or through MAISIE, removing an automatic link records it in `contactLinkDismissals`, so it does not come back.
- **If Mail or Calendar fails:** the other is still linked, and the failed one starts from the same place on the next run. Errors are in `/tmp/contact-autolink.log` and in `metadata/contactAutoLink`.
- **How to run it by hand:** `cd functions && npm run autolink:contacts -- --dry-run`, then without `--dry-run`.
- **First run (2026-10-06, 30 days):** launchd job loaded after a dry run. Meetings: 66 read, 57 links for 23 of them, 4 skipped as too large. Emails: 697 read, 313 links for 134 of them, 4 skipped as too large; 545 had no contact (mostly newsletters and notifications). 370 links in all, in about 95 seconds.

