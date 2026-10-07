import * as admin from "firebase-admin";
import {ContactDoc, CompanyDoc} from "./contacts";

/**
 * One-way import of Jack's iCloud contacts into MAISIE's CRM. iCloud is the
 * master copy of each person's details (Jack's choice, 2026-10-06).
 *
 * Apple Contacts is read on Jack's Mac (src/mcp/apple-contacts.ts) and handed
 * here as plain records. Nothing is ever written back to Apple Contacts.
 *
 * - Name, title, company, emails and phones of a contact tied to an iCloud card
 *   are replaced with the card's, so a correction in iCloud reaches MAISIE.
 *   Tags, notes and links exist only in MAISIE and are never touched.
 * - A contact whose iCloud card is gone is removed with its automatic links,
 *   unless it has notes or hand-made links. Then it is kept as a MAISIE-only
 *   contact: its appleContactId is cleared and leftICloudAt is set.
 * - Removals are held, and nothing is removed, when the read found no cards or
 *   would remove more than MAX_REMOVAL_SHARE of the iCloud contacts, so a
 *   failed or partial read cannot empty the address book.
 * - Contacts made in MAISIE (no appleContactId) are never removed.
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
  /** Contacts removed because their iCloud card is gone. */
  removed: number;
  /** Contacts whose iCloud card is gone, kept because they have notes or hand-made links. */
  keptNotInICloud: number;
  /** Removals not made because there were too many (see MAX_REMOVAL_SHARE); 0 when none were held. */
  removalsHeld: number;
  /** A few names from each group, so Jack can sanity-check a dry run. */
  examples: {created: string[]; updated: string[]; skipped: string[]; removed: string[]; keptNotInICloud: string[]};
}

export interface ImportOptions {
  dryRun?: boolean;
  /** Make the removals even when there are more than MAX_REMOVAL_SHARE of them. */
  allowManyRemovals?: boolean;
}

/** More removals than this share of the iCloud contacts are held for Jack to confirm. */
export const MAX_REMOVAL_SHARE = 0.2;
/** ...but a handful is always allowed, so a small address book can still lose a card. */
const MIN_HELD_REMOVALS = 10;
const IN_LIMIT = 30;

const EXAMPLE_LIMIT = 10;
const BATCH_LIMIT = 400;

interface ContactRow extends ContactDoc {
  id: string;
  appleContactId?: string | null;
  /** When the iCloud card was found gone and the contact kept; null otherwise. */
  leftICloudAt?: unknown;
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
  options: ImportOptions = {}
): Promise<ImportSummary> {
  const dryRun = options.dryRun ?? false;
  const [contactSnap, companySnap] = await Promise.all([
    db.collection("contacts").get(),
    db.collection("companies").get(),
  ]);

  // ── In-memory indexes, kept current as cards are merged ──
  const rows: ContactRow[] = contactSnap.docs.map((d) => {
    const c = d.data() as ContactDoc & {appleContactId?: string | null; leftICloudAt?: unknown};
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
      leftICloudAt: c.leftICloudAt ?? null,
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
    removed: 0, keptNotInICloud: 0, removalsHeld: 0,
    examples: {created: [], updated: [], skipped: [], removed: [], keptNotInICloud: []},
  };
  /** Contacts already matched to a card in this run. */
  const matched = new Set<ContactRow>();
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
      matched.add(row);
      summary.created++;
      note(summary.examples.created, name);
      continue;
    }

    const before = JSON.stringify([match.firstName, match.lastName, match.title, match.companyId, match.emails, match.phones, match.appleContactId, match.leftICloudAt]);
    // An address already on someone else stays with them.
    const ownEmails = emails.filter((e) => !byEmail.get(e) || byEmail.get(e) === match);
    if (matched.has(match)) {
      // A second iCloud card for the same person: add to the first, never replace it.
      if (!match.firstName && first) match.firstName = first;
      if (!match.lastName && last) match.lastName = last;
      if (!match.title && p.jobTitle.trim()) match.title = p.jobTitle.trim();
      if (!match.companyId && org) match.companyId = companyIdFor(org);
      match.emails = [...new Set([...match.emails, ...ownEmails])];
      match.phones = dedupePhones([...match.phones, ...phones]);
    } else {
      // ── iCloud is the master copy: its details replace MAISIE's ──
      match.firstName = first;
      match.lastName = last;
      match.title = p.jobTitle.trim() || null;
      match.companyId = org ? companyIdFor(org) : null;
      match.emails.filter((e) => !ownEmails.includes(e)).forEach((e) => byEmail.delete(e));
      match.emails = ownEmails;
      match.phones = dedupePhones(phones);
      if (p.appleId && match.appleContactId !== p.appleId) {
        if (match.appleContactId) byAppleId.delete(match.appleContactId);
        match.appleContactId = p.appleId;
      }
      match.leftICloudAt = null;
    }
    ownEmails.forEach((e) => byEmail.set(e, match));
    matched.add(match);
    index(match);

    const after = JSON.stringify([match.firstName, match.lastName, match.title, match.companyId, match.emails, match.phones, match.appleContactId, match.leftICloudAt]);
    if (after !== before) {
      match.changed = true;
      summary.updated++;
      if (!summary.examples.updated.includes(name)) note(summary.examples.updated, name);
    } else {
      summary.unchanged++;
    }
  }

  summary.companiesCreated = newCompanies.length;

  // ── Contacts whose iCloud card is gone ──
  const gone = rows.filter((r) => r.appleContactId && !matched.has(r));
  const fromICloud = rows.filter((r) => r.appleContactId).length;
  const limit = Math.max(MIN_HELD_REMOVALS, Math.floor(fromICloud * MAX_REMOVAL_SHARE));
  const toRemove: ContactRow[] = [];
  const toKeep: ContactRow[] = [];
  const autoLinks: Array<{ref: admin.firestore.DocumentReference; contactId: string}> = [];
  if (gone.length > 0 && (people.length === 0 || (gone.length > limit && !options.allowManyRemovals))) {
    summary.removalsHeld = gone.length;
  } else if (gone.length > 0) {
    const kept = new Set<string>();
    for (let i = 0; i < gone.length; i += IN_LIMIT) {
      const ids = gone.slice(i, i + IN_LIMIT).map((r) => r.id);
      const [notes, links] = await Promise.all([
        db.collection("contactNotes").where("contactId", "in", ids).get(),
        db.collection("contactLinks").where("contactId", "in", ids).get(),
      ]);
      notes.docs.forEach((n) => kept.add(n.data()["contactId"]));
      links.docs.filter((l) => l.data()["origin"] !== "auto").forEach((l) => kept.add(l.data()["contactId"]));
      links.docs.filter((l) => l.data()["origin"] === "auto")
        .forEach((l) => autoLinks.push({ref: l.ref, contactId: l.data()["contactId"]}));
    }
    for (const r of gone) {
      const name = fullName(r.firstName, r.lastName) || r.emails[0] || "(no name)";
      if (kept.has(r.id)) {
        r.appleContactId = null;
        r.leftICloudAt = admin.firestore.FieldValue.serverTimestamp();
        r.changed = true;
        toKeep.push(r);
        note(summary.examples.keptNotInICloud, name);
      } else {
        toRemove.push(r);
        note(summary.examples.removed, name);
      }
    }
    summary.removed = toRemove.length;
    summary.keptNotInICloud = toKeep.length;
  }
  if (dryRun) return summary;
  // Automatic links go with a removed contact; a kept contact keeps them.
  const removedIds = new Set(toRemove.map((r) => r.id));
  const removeLinks = autoLinks.filter((l) => removedIds.has(l.contactId)).map((l) => l.ref);

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
        leftICloudAt: r.leftICloudAt ?? null,
        updatedAt: now,
      };
      const ref = db.collection("contacts").doc(r.id);
      if (r.isNew) b.set(ref, {...fields, tags: [], createdAt: now});
      else b.update(ref, fields);
    }),
    ...removeLinks.map((ref) => (b: admin.firestore.WriteBatch) => b.delete(ref)),
    ...toRemove.map((r) => (b: admin.firestore.WriteBatch) => b.delete(db.collection("contacts").doc(r.id))),
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
