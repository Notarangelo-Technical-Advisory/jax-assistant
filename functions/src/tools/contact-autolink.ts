import * as admin from "firebase-admin";
import {createHash} from "crypto";
import {LinkDoc, linkKey, normDate, normMessageId} from "./contacts";

// ─── Automatic linking (CRM Phase 4) ───────────────────────────
//
// Ties emails and meetings to the contacts taking part in them, matched by
// email address. The readers live on Jack's Mac (src/mcp/autolink-contacts.ts),
// because Mail and Calendar are only reachable there; this file decides what
// to link and writes it, so the rules are tested against the emulator.
//
// - An automatic link has a fixed id made from the contact and the item, so a
//   second run finds it and writes nothing.
// - An item already linked by hand to the same contact is left alone.
// - When Jack removes an automatic link, a record in contactLinkDismissals
//   with the same id stops it from coming back.
// - Jack's own addresses are never matched, so his own contact card does not
//   collect every email and meeting.
// - An item with more than MAX_PEOPLE other people is skipped: an all-hands
//   meeting or a mailing to 40 people says little about any one contact.

export const MAX_PEOPLE = 15;

export interface AutoLinkItem {
  type: "email" | "meeting";
  /** Email: the Message-ID. Meeting: the calendar uid. */
  sourceId: string;
  title: string;
  /** ISO timestamp: when the email arrived or was sent, or the meeting starts. */
  date: string;
  /** Email: the sender, or "Sent by Jack". Meeting: the calendar name. */
  detail: string;
  /** Everyone on the item: sender and recipients, or organizer and attendees. */
  addresses: string[];
}

export interface AutoLinkOptions {
  /** Jack's own addresses, which are never matched. */
  ownAddresses: string[];
  dryRun?: boolean;
}

export interface AutoLinkSummary {
  dryRun: boolean;
  items: number;
  /** Links written, or that would be written in a dry run. */
  linked: number;
  /** Items with at least one link written. */
  itemsLinked: number;
  /** Already linked to that contact, by hand or by an earlier run. */
  alreadyLinked: number;
  /** Removed by Jack before, so not linked again. */
  dismissed: number;
  /** Skipped: more than MAX_PEOPLE other people. */
  tooManyPeople: number;
  /** No one on the item is a contact. */
  noContact: number;
  /** Up to 10 "Contact name: item title" lines. */
  examples: string[];
}

const IN_LIMIT = 30;
const BATCH_LIMIT = 400;

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({length: Math.ceil(list.length / size)}, (_, i) => list.slice(i * size, i * size + size));

/** Lower case, without angle brackets or a mailto: prefix; "" when it is not an address. */
export function normAddress(value: string): string {
  const a = value.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? a : "";
}

/** The fixed id of the automatic link between one contact and one item. */
export function autoLinkId(contactId: string, key: string): string {
  return "auto_" + createHash("sha1").update(`${contactId}|${key}`).digest("hex").slice(0, 32);
}

function contactName(data: Record<string, unknown>): string {
  return [data["firstName"], data["lastName"]].filter((p) => typeof p === "string" && p).join(" ") || "(no name)";
}

export async function autoLinkItems(
  db: admin.firestore.Firestore,
  items: AutoLinkItem[],
  options: AutoLinkOptions
): Promise<AutoLinkSummary> {
  const own = new Set(options.ownAddresses.map(normAddress).filter(Boolean));
  const summary: AutoLinkSummary = {
    dryRun: !!options.dryRun, items: items.length, linked: 0, itemsLinked: 0,
    alreadyLinked: 0, dismissed: 0, tooManyPeople: 0, noContact: 0, examples: [],
  };

  // Each item's other people, and the item as it would be stored.
  const prepared: Array<{doc: Omit<LinkDoc, "contactId">; key: string; people: string[]}> = [];
  for (const item of items) {
    const people = [...new Set(item.addresses.map(normAddress).filter((a) => a && !own.has(a)))];
    if (people.length > MAX_PEOPLE) {
      summary.tooManyPeople++;
      continue;
    }
    const date = normDate(item.date);
    const sourceId = item.type === "email" ? normMessageId(item.sourceId) : item.sourceId.trim();
    if (!sourceId || !date) continue;
    const doc: Omit<LinkDoc, "contactId"> = {
      companyId: null,
      type: item.type,
      title: item.title.trim() || (item.type === "email" ? "(no subject)" : "(untitled meeting)"),
      sourceId,
      url: null,
      date,
      detail: item.detail.trim() || null,
      note: null,
      origin: "auto",
    };
    prepared.push({doc, key: linkKey({...doc}), people});
  }

  // Which contact owns each address. One address belongs to one contact.
  const addresses = [...new Set(prepared.flatMap((p) => p.people))];
  const contactByAddress = new Map<string, {id: string; name: string}>();
  for (const part of chunks(addresses, IN_LIMIT)) {
    const snap = await db.collection("contacts").where("emails", "array-contains-any", part).get();
    for (const d of snap.docs) {
      for (const email of (d.data()["emails"] as string[] | undefined) ?? []) {
        if (part.includes(email) && !contactByAddress.has(email)) {
          contactByAddress.set(email, {id: d.id, name: contactName(d.data())});
        }
      }
    }
  }

  // Every candidate link: one per contact per item.
  const candidates: Array<{id: string; contactId: string; name: string; key: string; doc: Omit<LinkDoc, "contactId">}> = [];
  const candidateIds = new Set<string>();
  for (const p of prepared) {
    const contacts = new Map<string, string>();
    for (const a of p.people) {
      const c = contactByAddress.get(a);
      if (c) contacts.set(c.id, c.name);
    }
    if (contacts.size === 0) {
      summary.noContact++;
      continue;
    }
    for (const [contactId, name] of contacts) {
      const id = autoLinkId(contactId, p.key);
      // The same email can be read twice (Inbox and Sent, when Jack copies himself).
      if (candidateIds.has(id)) continue;
      candidateIds.add(id);
      candidates.push({id, contactId, name, key: p.key, doc: p.doc});
    }
  }

  // What each contact already has, so a link made by hand is not repeated.
  const contactIds = [...new Set(candidates.map((c) => c.contactId))];
  const existing = new Set<string>();
  for (const part of chunks(contactIds, IN_LIMIT)) {
    const snap = await db.collection("contactLinks").where("contactId", "in", part).get();
    for (const d of snap.docs) existing.add(`${d.data()["contactId"]}|${linkKey(d.data() as LinkDoc)}`);
  }
  const dismissed = new Set<string>();
  for (const part of chunks(candidates.map((c) => c.id), 100)) {
    const snaps = await db.getAll(...part.map((id) => db.collection("contactLinkDismissals").doc(id)));
    snaps.filter((s) => s.exists).forEach((s) => dismissed.add(s.id));
  }

  const toWrite = candidates.filter((c) => {
    if (dismissed.has(c.id)) {
      summary.dismissed++;
      return false;
    }
    if (existing.has(`${c.contactId}|${c.key}`)) {
      summary.alreadyLinked++;
      return false;
    }
    return true;
  });

  summary.linked = toWrite.length;
  summary.itemsLinked = new Set(toWrite.map((c) => c.key)).size;
  summary.examples = toWrite.slice(0, 10).map((c) => `${c.name}: ${c.doc.title}`);
  if (options.dryRun) return summary;

  for (const part of chunks(toWrite, BATCH_LIMIT)) {
    const batch = db.batch();
    for (const c of part) {
      batch.set(db.collection("contactLinks").doc(c.id), {
        ...c.doc,
        contactId: c.contactId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  return summary;
}
