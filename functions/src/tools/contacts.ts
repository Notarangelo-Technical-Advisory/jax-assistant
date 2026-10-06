import * as admin from "firebase-admin";

/**
 * Contacts, companies and notes — MAISIE's CRM / address book.
 *
 * Shared by the cloud chat function and the local MCP server through
 * execute.ts, and written to directly by the Angular contacts page. MAISIE is
 * the only home for this data: there is no sync back to Apple Contacts.
 *
 * Collections:
 *   contacts      — one person. `companyId` points at companies/{id}.
 *   companies     — one organisation.
 *   contactNotes  — a dated note on a contact OR a company (exactly one is set).
 *   contactLinks  — an email, meeting or web page tied to a contact OR a company.
 *
 * The company name is not copied onto contacts; it is resolved on read so a
 * rename never leaves stale copies behind. Search loads both collections and
 * filters in memory — fine for an address book of hundreds, and it avoids
 * keeping a derived search field in step between the server and the web app.
 */

export interface ContactDoc {
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  title: string | null;
  companyId: string | null;
  tags: string[];
}

export interface CompanyDoc {
  name: string;
  website: string | null;
  tags: string[];
}

const NOTE_LIMIT = 50;

const normEmails = (list?: string[]): string[] =>
  [...new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];

const normList = (list?: string[]): string[] =>
  [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))];

const fullName = (c: Pick<ContactDoc, "firstName" | "lastName">): string =>
  `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();

const toIso = (v: unknown): string | null =>
  v instanceof admin.firestore.Timestamp ? v.toDate().toISOString() : null;

async function loadCompanies(
  db: admin.firestore.Firestore
): Promise<Map<string, CompanyDoc>> {
  const snap = await db.collection("companies").get();
  return new Map(snap.docs.map((d) => [d.id, d.data() as CompanyDoc]));
}

/** Case-insensitive exact match on company name, creating it if absent. */
async function resolveCompany(
  db: admin.firestore.Firestore,
  name: string
): Promise<{id: string; created: boolean}> {
  const wanted = name.trim().toLowerCase();
  const companies = await loadCompanies(db);
  for (const [id, c] of companies) {
    if (c.name.trim().toLowerCase() === wanted) return {id, created: false};
  }
  const ref = await db.collection("companies").add({
    name: name.trim(),
    website: null,
    tags: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {id: ref.id, created: true};
}

async function loadNotes(
  db: admin.firestore.Firestore,
  field: "contactId" | "companyId",
  id: string
): Promise<Array<{id: string; body: string; createdAt: string | null}>> {
  const snap = await db.collection("contactNotes")
    .where(field, "==", id)
    .orderBy("createdAt", "desc")
    .limit(NOTE_LIMIT)
    .get();
  return snap.docs.map((d) => ({
    id: d.id,
    body: d.data()["body"] as string,
    createdAt: toIso(d.data()["createdAt"]),
  }));
}

function summarise(id: string, c: ContactDoc, companies: Map<string, CompanyDoc>) {
  return {
    id,
    name: fullName(c),
    title: c.title ?? null,
    company: c.companyId ? companies.get(c.companyId)?.name ?? null : null,
    companyId: c.companyId ?? null,
    emails: c.emails ?? [],
    phones: c.phones ?? [],
    tags: c.tags ?? [],
  };
}

// ─── find_contacts ─────────────────────────────────────────────

export async function findContacts(
  db: admin.firestore.Firestore,
  input: {query?: string; tag?: string; limit?: number}
): Promise<Record<string, unknown>> {
  const [contactSnap, companies] = await Promise.all([
    db.collection("contacts").get(),
    loadCompanies(db),
  ]);
  const q = input.query?.trim().toLowerCase() ?? "";
  const tag = input.tag?.trim().toLowerCase() ?? "";
  const limit = input.limit ?? 25;

  const contacts = contactSnap.docs
    .map((d) => summarise(d.id, d.data() as ContactDoc, companies))
    .filter((c) => {
      if (tag && !c.tags.some((t) => t.toLowerCase() === tag)) return false;
      if (!q) return true;
      const hay = [c.name, c.title ?? "", c.company ?? "", ...c.emails, ...c.phones, ...c.tags]
        .join(" ").toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const matchingCompanies = [...companies.entries()]
    .filter(([, c]) => {
      if (tag && !(c.tags ?? []).some((t) => t.toLowerCase() === tag)) return false;
      return !q || c.name.toLowerCase().includes(q) ||
        (c.website ?? "").toLowerCase().includes(q);
    })
    .map(([id, c]) => ({id, name: c.name, website: c.website ?? null, tags: c.tags ?? []}))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    contacts: contacts.slice(0, limit),
    contactCount: contacts.length,
    truncated: contacts.length > limit,
    companies: matchingCompanies.slice(0, limit),
  };
}

// ─── get_contact / get_company ─────────────────────────────────

export async function getContact(
  db: admin.firestore.Firestore,
  contactId: string
): Promise<Record<string, unknown>> {
  const snap = await db.collection("contacts").doc(contactId).get();
  if (!snap.exists) return {success: false, error: `Contact "${contactId}" not found.`};
  const c = snap.data() as ContactDoc;
  const [companies, notes, links] = await Promise.all([
    loadCompanies(db),
    loadNotes(db, "contactId", contactId),
    loadLinks(db, "contactId", contactId),
  ]);
  return {
    success: true,
    contact: {
      ...summarise(snap.id, c, companies),
      firstName: c.firstName,
      lastName: c.lastName,
      createdAt: toIso(snap.data()?.["createdAt"]),
      updatedAt: toIso(snap.data()?.["updatedAt"]),
    },
    notes,
    links,
  };
}

export async function getCompany(
  db: admin.firestore.Firestore,
  companyId: string
): Promise<Record<string, unknown>> {
  const snap = await db.collection("companies").doc(companyId).get();
  if (!snap.exists) return {success: false, error: `Company "${companyId}" not found.`};
  const c = snap.data() as CompanyDoc;
  const [people, notes, links] = await Promise.all([
    db.collection("contacts").where("companyId", "==", companyId).get(),
    loadNotes(db, "companyId", companyId),
    loadLinks(db, "companyId", companyId),
  ]);
  return {
    success: true,
    company: {id: snap.id, name: c.name, website: c.website ?? null, tags: c.tags ?? []},
    contacts: people.docs
      .map((d) => {
        const p = d.data() as ContactDoc;
        return {id: d.id, name: fullName(p), title: p.title ?? null, emails: p.emails ?? []};
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    notes,
    links,
  };
}

// ─── save_contact ──────────────────────────────────────────────

export interface SaveContactInput {
  contact_id?: string;
  first_name?: string;
  last_name?: string;
  emails?: string[];
  phones?: string[];
  title?: string | null;
  /** Company name. Matched case-insensitively, created if new. "" or null clears it. */
  company?: string | null;
  tags?: string[];
}

export async function saveContact(
  db: admin.firestore.Firestore,
  input: SaveContactInput
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  if (input.first_name !== undefined) fields["firstName"] = input.first_name.trim();
  if (input.last_name !== undefined) fields["lastName"] = input.last_name.trim();
  if (input.emails !== undefined) fields["emails"] = normEmails(input.emails);
  if (input.phones !== undefined) fields["phones"] = normList(input.phones);
  if (input.title !== undefined) fields["title"] = input.title?.trim() || null;
  if (input.tags !== undefined) fields["tags"] = normList(input.tags);

  // Resolved only after validation passes, so a rejected call never leaves a
  // freshly created company behind.
  let companyCreated = false;
  const applyCompany = async (): Promise<void> => {
    if (input.company === undefined) return;
    if (input.company && input.company.trim()) {
      const resolved = await resolveCompany(db, input.company);
      fields["companyId"] = resolved.id;
      companyCreated = resolved.created;
    } else {
      fields["companyId"] = null;
    }
  };

  // ── Update ──
  if (input.contact_id) {
    const ref = db.collection("contacts").doc(input.contact_id);
    const snap = await ref.get();
    if (!snap.exists) return {success: false, error: `Contact "${input.contact_id}" not found.`};
    if (Object.keys(fields).length === 0 && input.company === undefined) {
      return {success: false, error: "Nothing to update — pass at least one field."};
    }
    await applyCompany();
    fields["updatedAt"] = admin.firestore.FieldValue.serverTimestamp();
    await ref.update(fields);
    return {success: true, contactId: ref.id, created: false, companyCreated};
  }

  // ── Create ──
  if (!fields["firstName"] && !fields["lastName"]) {
    return {success: false, error: "A new contact needs at least a first or last name."};
  }
  // Email is the one reliable identity key. Refuse a second record for the
  // same address so an import or a repeated request cannot fork a person.
  const emails = (fields["emails"] as string[] | undefined) ?? [];
  if (emails.length > 0) {
    const dup = await db.collection("contacts")
      .where("emails", "array-contains-any", emails.slice(0, 30)).limit(1).get();
    if (!dup.empty) {
      const existing = dup.docs[0];
      return {
        success: false,
        error: `A contact with that email already exists: ${fullName(existing.data() as ContactDoc)} (${existing.id}). Update it with contact_id instead.`,
        existingContactId: existing.id,
      };
    }
  }
  await applyCompany();
  const ref = await db.collection("contacts").add({
    firstName: "",
    lastName: "",
    emails: [],
    phones: [],
    title: null,
    companyId: null,
    tags: [],
    ...fields,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {success: true, contactId: ref.id, created: true, companyCreated};
}

// ─── save_company ──────────────────────────────────────────────

export async function saveCompany(
  db: admin.firestore.Firestore,
  input: {company_id?: string; name?: string; website?: string | null; tags?: string[]}
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields["name"] = input.name.trim();
  if (input.website !== undefined) fields["website"] = input.website?.trim() || null;
  if (input.tags !== undefined) fields["tags"] = normList(input.tags);

  if (input.company_id) {
    const ref = db.collection("companies").doc(input.company_id);
    const snap = await ref.get();
    if (!snap.exists) return {success: false, error: `Company "${input.company_id}" not found.`};
    if (Object.keys(fields).length === 0) {
      return {success: false, error: "Nothing to update — pass at least one field."};
    }
    fields["updatedAt"] = admin.firestore.FieldValue.serverTimestamp();
    await ref.update(fields);
    return {success: true, companyId: ref.id, created: false};
  }

  if (!fields["name"]) return {success: false, error: "A new company needs a name."};
  const resolved = await resolveCompany(db, fields["name"] as string);
  if (!resolved.created) {
    return {
      success: false,
      error: `A company named "${fields["name"]}" already exists (${resolved.id}). Update it with company_id instead.`,
      existingCompanyId: resolved.id,
    };
  }
  const rest = {...fields};
  delete rest["name"];
  if (Object.keys(rest).length > 0) {
    await db.collection("companies").doc(resolved.id).update(rest);
  }
  return {success: true, companyId: resolved.id, created: true};
}

// ─── add_contact_note ──────────────────────────────────────────

export async function addContactNote(
  db: admin.firestore.Firestore,
  input: {contact_id?: string; company_id?: string; body: string}
): Promise<Record<string, unknown>> {
  if (!!input.contact_id === !!input.company_id) {
    return {success: false, error: "Pass exactly one of contact_id or company_id."};
  }
  const body = input.body?.trim();
  if (!body) return {success: false, error: "The note is empty."};

  const target = input.contact_id
    ? db.collection("contacts").doc(input.contact_id)
    : db.collection("companies").doc(input.company_id as string);
  if (!(await target.get()).exists) {
    return {success: false, error: `${input.contact_id ? "Contact" : "Company"} "${target.id}" not found.`};
  }

  const ref = await db.collection("contactNotes").add({
    contactId: input.contact_id ?? null,
    companyId: input.company_id ?? null,
    body,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {success: true, noteId: ref.id};
}

// ─── Links: emails, meetings and web pages ─────────────────────
//
// A link is a self-contained record: it keeps its own title, date and source
// details rather than pointing at another collection, because the calendar
// mirror deletes events once they pass and Mail is only reachable from Jack's
// Mac. The Message-ID or calendar uid is kept so the item can be found again.

export type LinkType = "email" | "meeting" | "url";
const LINK_TYPES: LinkType[] = ["email", "meeting", "url"];
const LINK_LIMIT = 100;

export interface LinkInput {
  contact_id?: string;
  company_id?: string;
  type: LinkType;
  title: string;
  /** Email: the Message-ID. Meeting: the Apple Calendar uid. Unused for url. */
  source_id?: string;
  /** http(s) only. Required for url; a meeting's join link otherwise. */
  url?: string;
  /** YYYY-MM-DD or an ISO timestamp. Required for a meeting. */
  date?: string;
  /** Email: the sender. Meeting: the calendar name. */
  detail?: string;
  note?: string;
}

interface LinkDoc {
  contactId: string | null;
  companyId: string | null;
  type: LinkType;
  title: string;
  sourceId: string | null;
  url: string | null;
  date: string | null;
  detail: string | null;
  note: string | null;
}

/** True for an absolute http or https URL — the only kinds the page will open. */
export function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Mail's message id comes without angle brackets; accept it either way. */
const normMessageId = (id: string): string => id.trim().replace(/^<|>$/g, "");

/** Accepts YYYY-MM-DD or a full timestamp; returns null if it is not a date. */
function normDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** What makes two links the same thing, so the same email is not linked twice. */
function linkKey(l: Pick<LinkDoc, "type" | "sourceId" | "url" | "date" | "title">): string {
  switch (l.type) {
  case "email": return `email|${l.sourceId}`;
  // Every occurrence of a recurring meeting shares one uid, so the date is part
  // of a meeting's identity; without a uid, its title stands in.
  case "meeting": return `meeting|${l.sourceId ?? l.title.toLowerCase()}|${(l.date ?? "").slice(0, 10)}`;
  default: return `url|${l.url}`;
  }
}

/** Newest first by the item's own date, falling back to when it was linked. */
async function loadLinks(
  db: admin.firestore.Firestore,
  field: "contactId" | "companyId",
  id: string
): Promise<Array<Record<string, unknown>>> {
  const snap = await db.collection("contactLinks").where(field, "==", id).limit(LINK_LIMIT).get();
  return snap.docs
    .map((d) => {
      const l = d.data() as LinkDoc;
      return {
        id: d.id,
        type: l.type,
        title: l.title,
        date: l.date ?? null,
        detail: l.detail ?? null,
        url: l.url ?? null,
        sourceId: l.sourceId ?? null,
        note: l.note ?? null,
        linkedAt: toIso(d.data()["createdAt"]),
      };
    })
    .sort((a, b) => (b.date ?? b.linkedAt ?? "").localeCompare(a.date ?? a.linkedAt ?? ""));
}

export async function linkToContact(
  db: admin.firestore.Firestore,
  input: LinkInput
): Promise<Record<string, unknown>> {
  if (!!input.contact_id === !!input.company_id) {
    return {success: false, error: "Pass exactly one of contact_id or company_id."};
  }
  if (!LINK_TYPES.includes(input.type)) {
    return {success: false, error: `type must be one of: ${LINK_TYPES.join(", ")}.`};
  }
  const title = input.title?.trim();
  if (!title) return {success: false, error: "A link needs a title (the email subject, meeting name or page name)."};

  const url = input.url?.trim() || null;
  if (url && !isWebUrl(url)) return {success: false, error: "url must start with http:// or https://."};

  let date: string | null = null;
  if (input.date?.trim()) {
    date = normDate(input.date);
    if (!date) return {success: false, error: `"${input.date}" is not a date. Use YYYY-MM-DD.`};
  }

  let sourceId = input.source_id?.trim() || null;
  if (input.type === "email") {
    if (!sourceId) return {success: false, error: "An email link needs source_id: the message_id from mail_search."};
    sourceId = normMessageId(sourceId);
  }
  if (input.type === "meeting" && !date) {
    return {success: false, error: "A meeting link needs the meeting's date."};
  }
  if (input.type === "url") {
    if (!url) return {success: false, error: "A web link needs a url."};
    sourceId = null;
  }

  const field = input.contact_id ? "contactId" : "companyId";
  const targetId = (input.contact_id ?? input.company_id) as string;
  const target = db.collection(input.contact_id ? "contacts" : "companies").doc(targetId);
  if (!(await target.get()).exists) {
    return {success: false, error: `${input.contact_id ? "Contact" : "Company"} "${targetId}" not found.`};
  }

  const doc: LinkDoc = {
    contactId: input.contact_id ?? null,
    companyId: input.company_id ?? null,
    type: input.type,
    title,
    sourceId,
    url,
    date,
    detail: input.detail?.trim() || null,
    note: input.note?.trim() || null,
  };

  const existing = await db.collection("contactLinks").where(field, "==", targetId).get();
  const key = linkKey(doc);
  const dup = existing.docs.find((d) => linkKey(d.data() as LinkDoc) === key);
  if (dup) {
    return {success: false, error: `That ${input.type} is already linked ("${dup.data()["title"]}").`, existingLinkId: dup.id};
  }

  const ref = await db.collection("contactLinks").add({
    ...doc,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {success: true, linkId: ref.id};
}

export async function removeContactLink(
  db: admin.firestore.Firestore,
  linkId: string
): Promise<Record<string, unknown>> {
  const ref = db.collection("contactLinks").doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) return {success: false, error: `Link "${linkId}" not found.`};
  await ref.delete();
  return {success: true, removed: {type: snap.data()?.["type"], title: snap.data()?.["title"]}};
}
