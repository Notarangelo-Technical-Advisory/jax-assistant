import * as admin from "firebase-admin";
import {ContactDoc, CompanyDoc} from "./contacts";

/**
 * One-way import of Apple Contacts into MAISIE's CRM.
 *
 * Apple Contacts is read on Jack's Mac (src/mcp/apple-contacts.ts) and handed
 * here as plain records. Nothing is ever written back to Apple Contacts, and
 * the import only ever adds: it never removes a contact, an email address, a
 * phone number, a note or a link, and it never overwrites a field Jack has
 * filled in or edited in MAISIE. Apple fills blanks; MAISIE wins otherwise.
 * That makes it safe to run again whenever Jack likes.
 *
 * Matching an Apple card to an existing contact, in order:
 *   1. The Apple contact identifier stored by an earlier import.
 *   2. Any shared email address (MAISIE's identity rule).
 *   3. An exact full-name match, only when exactly one contact has that name
 *      and it has not already been matched to a different Apple card.
 * Anything else becomes a new contact.
 */

export interface ApplePerson {
  /** CNContact.identifier — stable across runs on the same Mac. */
  appleId: string;
  kind: "person" | "organization";
  firstName: string;
  lastName: string;
  organization: string;
  jobTitle: string;
  emails: string[];
  phones: string[];
}

export interface ImportSummary {
  success: true;
  dryRun: boolean;
  /** Cards read from Apple Contacts. Each lands in exactly one of the next five counts. */
  read: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Company cards, and person cards with only a company name. */
  companyCards: number;
  /** Cards with no name and no company. */
  skipped: number;
  /** Companies that did not exist before, from any card. */
  companiesCreated: number;
  /** A few names from each group, so Jack can sanity-check a dry run. */
  examples: {created: string[]; updated: string[]; skipped: string[]};
}

const EXAMPLE_LIMIT = 10;
const BATCH_LIMIT = 400;

interface ContactRow extends ContactDoc {
  id: string;
  appleContactId?: string | null;
  changed: boolean;
  isNew: boolean;
}

const lower = (s: string): string => s.trim().toLowerCase();
const fullName = (first: string, last: string): string => `${first} ${last}`.trim();

/** Compare phone numbers by their last 10 digits, so "+1 (617) 555-0100" equals "617.555.0100". */
const phoneKey = (p: string): string => p.replace(/\D/g, "").slice(-10);

export async function importContacts(
  db: admin.firestore.Firestore,
  people: ApplePerson[],
  options: {dryRun?: boolean} = {}
): Promise<ImportSummary> {
  const dryRun = options.dryRun ?? false;
  const [contactSnap, companySnap] = await Promise.all([
    db.collection("contacts").get(),
    db.collection("companies").get(),
  ]);

  // ── In-memory indexes, kept current as cards are merged ──
  const rows: ContactRow[] = contactSnap.docs.map((d) => {
    const c = d.data() as ContactDoc & {appleContactId?: string | null};
    return {
      id: d.id,
      firstName: c.firstName ?? "",
      lastName: c.lastName ?? "",
      emails: [...(c.emails ?? [])],
      phones: [...(c.phones ?? [])],
      title: c.title ?? null,
      companyId: c.companyId ?? null,
      tags: c.tags ?? [],
      appleContactId: c.appleContactId ?? null,
      changed: false,
      isNew: false,
    };
  });
  const byAppleId = new Map<string, ContactRow>();
  const byEmail = new Map<string, ContactRow>();
  const byName = new Map<string, ContactRow[]>();
  const index = (row: ContactRow): void => {
    if (row.appleContactId) byAppleId.set(row.appleContactId, row);
    row.emails.forEach((e) => byEmail.set(e, row));
    const name = lower(fullName(row.firstName, row.lastName));
    if (name) byName.set(name, [...(byName.get(name) ?? []).filter((r) => r !== row), row]);
  };
  rows.forEach(index);

  const companyByName = new Map<string, string>();
  companySnap.docs.forEach((d) => companyByName.set(lower((d.data() as CompanyDoc).name ?? ""), d.id));
  const newCompanies: Array<{id: string; name: string}> = [];
  const companyIdFor = (name: string): string | null => {
    const key = lower(name);
    if (!key) return null;
    const existing = companyByName.get(key);
    if (existing) return existing;
    const id = db.collection("companies").doc().id;
    companyByName.set(key, id);
    newCompanies.push({id, name: name.trim()});
    return id;
  };

  const summary: ImportSummary = {
    success: true, dryRun, read: people.length,
    created: 0, updated: 0, unchanged: 0, companyCards: 0, skipped: 0, companiesCreated: 0,
    examples: {created: [], updated: [], skipped: []},
  };
  const note = (list: string[], name: string): void => {
    if (list.length < EXAMPLE_LIMIT) list.push(name);
  };

  for (const p of people) {
    const first = p.firstName.trim();
    const last = p.lastName.trim();
    const org = p.organization.trim();
    const emails = [...new Set(p.emails.map(lower).filter((e) => e.includes("@")))];
    const phones = p.phones.map((x) => x.trim()).filter((x) => phoneKey(x).length >= 7);

    // A company card, or a person card with only a company name, adds the company.
    if (p.kind === "organization" || (!first && !last)) {
      if (org) {
        companyIdFor(org);
        summary.companyCards++;
      } else {
        summary.skipped++;
        note(summary.examples.skipped, emails[0] ?? phones[0] ?? "(card with no name)");
      }
      continue;
    }

    const name = fullName(first, last);
    const nameMatches = (byName.get(lower(name)) ?? [])
      .filter((r) => !r.appleContactId || r.appleContactId === p.appleId);
    const match =
      (p.appleId ? byAppleId.get(p.appleId) : undefined) ??
      emails.map((e) => byEmail.get(e)).find(Boolean) ??
      (nameMatches.length === 1 ? nameMatches[0] : undefined);

    if (!match) {
      const row: ContactRow = {
        id: db.collection("contacts").doc().id,
        firstName: first,
        lastName: last,
        emails,
        phones: dedupePhones(phones),
        title: p.jobTitle.trim() || null,
        companyId: org ? companyIdFor(org) : null,
        tags: [],
        appleContactId: p.appleId || null,
        changed: true,
        isNew: true,
      };
      rows.push(row);
      index(row);
      summary.created++;
      note(summary.examples.created, name);
      continue;
    }

    // ── Merge into the existing contact: fill blanks, add, never replace ──
    const before = JSON.stringify([match.firstName, match.lastName, match.title, match.companyId, match.emails, match.phones, match.appleContactId]);
    if (!match.firstName && first) match.firstName = first;
    if (!match.lastName && last) match.lastName = last;
    if (!match.title && p.jobTitle.trim()) match.title = p.jobTitle.trim();
    if (!match.companyId && org) match.companyId = companyIdFor(org);
    for (const e of emails) {
      const owner = byEmail.get(e);
      // An address already on someone else stays with them.
      if (!owner) {
        match.emails.push(e);
        byEmail.set(e, match);
      }
    }
    match.phones = dedupePhones([...match.phones, ...phones]);
    if (!match.appleContactId && p.appleId) {
      match.appleContactId = p.appleId;
      byAppleId.set(p.appleId, match);
    }
    index(match);

    const after = JSON.stringify([match.firstName, match.lastName, match.title, match.companyId, match.emails, match.phones, match.appleContactId]);
    if (after !== before) {
      match.changed = true;
      summary.updated++;
      if (!summary.examples.updated.includes(name)) note(summary.examples.updated, name);
    } else {
      summary.unchanged++;
    }
  }

  summary.companiesCreated = newCompanies.length;
  if (dryRun) return summary;

  // ── Write: companies first, so no contact points at a missing company ──
  const now = admin.firestore.FieldValue.serverTimestamp();
  const writes: Array<(b: admin.firestore.WriteBatch) => void> = [
    ...newCompanies.map((c) => (b: admin.firestore.WriteBatch) =>
      b.set(db.collection("companies").doc(c.id), {name: c.name, website: null, tags: [], createdAt: now, updatedAt: now})),
    ...rows.filter((r) => r.changed).map((r) => (b: admin.firestore.WriteBatch) => {
      const fields = {
        firstName: r.firstName,
        lastName: r.lastName,
        emails: r.emails,
        phones: r.phones,
        title: r.title,
        companyId: r.companyId,
        appleContactId: r.appleContactId ?? null,
        updatedAt: now,
      };
      const ref = db.collection("contacts").doc(r.id);
      if (r.isNew) b.set(ref, {...fields, tags: [], createdAt: now});
      else b.update(ref, fields);
    }),
  ];
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    writes.slice(i, i + BATCH_LIMIT).forEach((w) => w(batch));
    await batch.commit();
  }
  return summary;
}

/** Keeps the first spelling of each number. */
function dedupePhones(phones: string[]): string[] {
  const seen = new Set<string>();
  return phones.filter((p) => {
    const key = phoneKey(p) || p;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
