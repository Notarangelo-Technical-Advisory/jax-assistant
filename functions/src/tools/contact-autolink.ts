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
// - An email from an automated sender (no-reply@, notifications@ and so on)
//   is skipped: an alert copied to a contact says nothing about them.

export const MAX_PEOPLE = 15;

/** The part before the @ of senders that are machines, not people. */
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|bounces?)([-+._].*)?$/i;

/** True for no-reply@, do-not-reply@, notifications@, alerts@ and similar addresses. */
export function isAutomatedSender(address: string): boolean {
  const a = normAddress(address);
  return !!a && AUTOMATED_SENDER.test(a.split("@")[0]);
}

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
  /** Email only: the sender's address, to skip automated senders. */
  sender?: string;
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
  /** Skipped: an email from an automated sender, such as no-reply@. */
  automated: number;
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
    alreadyLinked: 0, dismissed: 0, tooManyPeople: 0, automated: 0, noContact: 0, examples: [],
  };

  // Each item's other people, and the item as it would be stored.
  const prepared: Array<{doc: Omit<LinkDoc, "contactId">; key: string; people: string[]}> = [];
  for (const item of items) {
    if (item.type === "email" && item.sender && isAutomatedSender(item.sender)) {
      summary.automated++;
      continue;
    }
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

// ─── Text messages ─────────────────────────────────────────────
//
// Ties iMessage and SMS conversations to contacts, matched by phone number or
// by the email address someone uses for iMessage. The reader on Jack's Mac
// (src/mcp/apple-messages.ts) groups messages into one item per conversation
// per day. Here, those become one link per contact per day:
//
// - The link's date is the day; its title is the first line of the day's first
//   message, cut to TEXT_LINE_LIMIT characters; its detail is the number of
//   messages. Nothing else of the conversation is stored.
// - A conversation of more than MAX_PEOPLE other people is skipped, as for
//   email. A contact in two conversations on one day gets one link, with the
//   messages of both counted.
// - More texts arrive during the day, so a later run updates the day's link.
//   A link Jack removed is not put back, as for email and meetings.

export const TEXT_LINE_LIMIT = 80;

export interface TextDayItem {
  /** The conversation, as the Messages database numbers it. */
  chatId: string;
  /** YYYY-MM-DD in Jack's time zone. */
  day: string;
  /** ISO timestamp of the day's first message. */
  firstAt: string;
  /** Messages in the conversation that day, from Jack and from the others. */
  count: number;
  /** The day's first message with words in it, or "" if there was none. */
  firstLine: string;
  /** The other people: phone numbers and iMessage email addresses. */
  handles: string[];
}

export interface TextLinkSummary extends AutoLinkSummary {
  /** Links from an earlier run whose count or first line changed. */
  updated: number;
}

/** Phone numbers compared by their last 10 digits; "" for anything shorter than 7. */
export function phoneKey(value: string): string {
  const digits = value.replace(/\D/g, "").slice(-10);
  return digits.length >= 7 ? digits : "";
}

/** A phone number or an email address, in the form contacts are matched on. */
export function handleKey(handle: string): string {
  return handle.includes("@") ? normAddress(handle) : phoneKey(handle);
}

/** The first line, at most TEXT_LINE_LIMIT characters, with an ellipsis when cut. */
export function firstLineOf(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > TEXT_LINE_LIMIT ? `${line.slice(0, TEXT_LINE_LIMIT - 1).trimEnd()}…` : line;
}

export async function autoLinkTexts(
  db: admin.firestore.Firestore,
  items: TextDayItem[],
  options: {dryRun?: boolean} = {}
): Promise<TextLinkSummary> {
  const summary: TextLinkSummary = {
    dryRun: !!options.dryRun, items: items.length, linked: 0, itemsLinked: 0, updated: 0,
    alreadyLinked: 0, dismissed: 0, tooManyPeople: 0, automated: 0, noContact: 0, examples: [],
  };

  if (items.length === 0) return summary;

  // Phone numbers are stored as typed, so every contact is read and matched here.
  const contactByHandle = new Map<string, {id: string; name: string}>();
  for (const d of (await db.collection("contacts").get()).docs) {
    const data = d.data();
    const keys = [
      ...((data["emails"] as string[] | undefined) ?? []).map(normAddress),
      ...((data["phones"] as string[] | undefined) ?? []).map(phoneKey),
    ];
    for (const k of keys) {
      if (k && !contactByHandle.has(k)) contactByHandle.set(k, {id: d.id, name: contactName(data)});
    }
  }

  // One entry per contact per day, adding up every conversation they were in.
  const days = new Map<string, {contactId: string; name: string; day: string; count: number; firstAt: string; firstLine: string; lineAt: string}>();
  for (const item of items) {
    const handles = [...new Set(item.handles.map(handleKey).filter(Boolean))];
    if (handles.length > MAX_PEOPLE) {
      summary.tooManyPeople++;
      continue;
    }
    const contacts = new Map(handles.flatMap((h) => {
      const c = contactByHandle.get(h);
      return c ? [[c.id, c.name] as const] : [];
    }));
    if (contacts.size === 0) {
      summary.noContact++;
      continue;
    }
    for (const [contactId, name] of contacts) {
      const key = `${contactId}|${item.day}`;
      const day = days.get(key);
      if (!day) {
        days.set(key, {contactId, name, day: item.day, count: item.count, firstAt: item.firstAt, firstLine: item.firstLine, lineAt: item.firstAt});
        continue;
      }
      day.count += item.count;
      if (item.firstAt < day.firstAt) day.firstAt = item.firstAt;
      // The first line comes from whichever conversation started first that day.
      if (item.firstLine && (!day.firstLine || item.firstAt < day.lineAt)) {
        day.firstLine = item.firstLine;
        day.lineAt = item.firstAt;
      }
    }
  }

  const candidates = [...days.values()].map((d) => {
    const doc: Omit<LinkDoc, "contactId"> = {
      companyId: null,
      type: "text",
      title: firstLineOf(d.firstLine) || "(photo or attachment)",
      sourceId: d.day,
      url: null,
      date: d.day,
      detail: d.count === 1 ? "1 message" : `${d.count} messages`,
      note: null,
      origin: "auto",
    };
    return {id: autoLinkId(d.contactId, linkKey(doc)), contactId: d.contactId, name: d.name, doc};
  });

  const ids = candidates.map((c) => c.id);
  const existing = new Map<string, Record<string, unknown>>();
  const dismissed = new Set<string>();
  for (const part of chunks(ids, 100)) {
    const links = await db.getAll(...part.map((id) => db.collection("contactLinks").doc(id)));
    links.filter((s) => s.exists).forEach((s) => existing.set(s.id, s.data() ?? {}));
    const gone = await db.getAll(...part.map((id) => db.collection("contactLinkDismissals").doc(id)));
    gone.filter((s) => s.exists).forEach((s) => dismissed.add(s.id));
  }

  const toCreate: typeof candidates = [];
  const toUpdate: typeof candidates = [];
  for (const c of candidates) {
    const old = existing.get(c.id);
    if (dismissed.has(c.id)) summary.dismissed++;
    else if (!old) toCreate.push(c);
    else if (old["title"] !== c.doc.title || old["detail"] !== c.doc.detail) toUpdate.push(c);
    else summary.alreadyLinked++;
  }

  summary.linked = toCreate.length;
  summary.updated = toUpdate.length;
  summary.itemsLinked = new Set(toCreate.map((c) => c.doc.sourceId)).size;
  summary.examples = toCreate.slice(0, 10).map((c) => `${c.name}: ${c.doc.date}, ${c.doc.detail}`);
  if (options.dryRun) return summary;

  const writes = [
    ...toCreate.map((c) => ({c, data: {...c.doc, contactId: c.contactId, createdAt: admin.firestore.FieldValue.serverTimestamp()}})),
    ...toUpdate.map((c) => ({c, data: {title: c.doc.title, detail: c.doc.detail}})),
  ];
  for (const part of chunks(writes, BATCH_LIMIT)) {
    const batch = db.batch();
    for (const {c, data} of part) batch.set(db.collection("contactLinks").doc(c.id), data, {merge: true});
    await batch.commit();
  }
  return summary;
}
