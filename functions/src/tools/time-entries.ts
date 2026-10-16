import {getFtaFirestore, getCustomers, getActiveProjects, Customer, Project} from "../fta-client";
import {etDateKey} from "../et-time";

/**
 * Writing time entries into the NTA time tracker (Firestore project
 * fta-invoice-tracking) from the chat, usually after Maisie has summarized the
 * work journal.
 *
 * Entries are written in the same shape the tracker's own form writes
 * (nta-time-tracker, time-entry-form.component.ts), so the tracker can show,
 * edit and invoice them like any other entry. Two rules follow from that form:
 *   - times are on the hour or half hour, because its start and end pickers
 *     offer nothing else, and an entry at 10:15 would open with blank times;
 *   - durationHours is end minus start, as its calculateDuration() works it out.
 *
 * Each entry also carries `source: "maisie"`. The tracker ignores the field;
 * delete_time_entry uses it so Maisie can only remove what she posted.
 */

const MAX_ENTRIES = 50;
const MAX_DESCRIPTION_LENGTH = 1000;
const TIME = /^([01]\d|2[0-3]):(00|30)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface TimeEntryInput {
  date?: string;
  customer?: string;
  project?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
}

interface CheckedEntry {
  date: string;
  startTime: string;
  endTime: string;
  durationHours: number;
  customer: Customer;
  project: Project;
  description: string;
}

const minutes = (time: string): number => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const same = (a: string | undefined, b: string): boolean =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** A customer by Firestore ID, company name or customer code, ignoring capitals. */
function findCustomer(customers: Customer[], wanted: string): Customer | undefined {
  return customers.find((c) => c.id === wanted.trim()) ??
    customers.find((c) => same(c.companyName, wanted) || same(c.customerId, wanted));
}

/** A project by Firestore ID, name or project code; the only one when none is named. */
function findProject(projects: Project[], wanted: string | undefined): Project | string {
  if (!wanted?.trim()) {
    if (projects.length === 1) return projects[0];
    return projects.length === 0 ?
      "has no active project in the time tracker" :
      `has ${projects.length} active projects, so name one: ${projects.map((p) => p.projectName).join(", ")}`;
  }
  const found = projects.find((p) => p.id === wanted.trim()) ??
    projects.find((p) => same(p.projectName, wanted) || same(p.projectId, wanted));
  return found ?? `has no active project "${wanted}". Active projects: ${projects.map((p) => p.projectName).join(", ") || "none"}`;
}

/**
 * Check every entry, and post them all only when every one passes and dry_run
 * is false. Nothing is written when any entry fails, so a refused batch never
 * leaves half of a day posted.
 */
export async function addTimeEntries(input: {
  entries?: TimeEntryInput[];
  dry_run?: boolean;
}): Promise<Record<string, unknown>> {
  // A dry run unless told otherwise, so a model cannot post by leaving the flag out.
  const dryRun = input.dry_run !== false;
  const entries = input.entries ?? [];
  if (entries.length === 0) return {success: false, error: "Give at least one entry."};
  if (entries.length > MAX_ENTRIES) {
    return {success: false, error: `Post at most ${MAX_ENTRIES} entries at a time; this has ${entries.length}.`};
  }

  const fta = getFtaFirestore();
  const customers = await getCustomers();
  const projectsByCustomer = new Map<string, Project[]>();
  const today = etDateKey(new Date());
  const problems: string[] = [];
  const checked: CheckedEntry[] = [];

  for (const [i, e] of entries.entries()) {
    const label = `Entry ${i + 1}${e.date ? ` (${e.date})` : ""}`;
    const fail = (why: string) => problems.push(`${label}: ${why}.`);

    if (!e.date || !DATE.test(e.date) || Number.isNaN(Date.parse(e.date))) {
      fail("the date must be YYYY-MM-DD");
      continue;
    }
    if (e.date > today) {
      fail(`${e.date} is in the future`);
      continue;
    }
    if (!e.start_time || !TIME.test(e.start_time) || !e.end_time || !TIME.test(e.end_time)) {
      fail("start and end times must be HH:MM on the hour or half hour (24-hour, ET), because the time tracker offers only those");
      continue;
    }
    if (minutes(e.end_time) <= minutes(e.start_time)) {
      fail("the end time must be after the start time, on the same day");
      continue;
    }
    const description = (e.description ?? "").trim();
    if (!description) {
      fail("the description is empty");
      continue;
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      fail(`the description is ${description.length} characters; keep it under ${MAX_DESCRIPTION_LENGTH}`);
      continue;
    }
    const customer = e.customer ? findCustomer(customers, e.customer) : undefined;
    if (!customer) {
      fail(`no active customer "${e.customer ?? ""}". Active customers: ${customers.map((c) => c.companyName).join(", ") || "none"}`);
      continue;
    }
    if (!projectsByCustomer.has(customer.id)) {
      projectsByCustomer.set(customer.id, await getActiveProjects(customer.id));
    }
    const project = findProject(projectsByCustomer.get(customer.id) ?? [], e.project);
    if (typeof project === "string") {
      fail(`${customer.companyName} ${project}`);
      continue;
    }

    checked.push({
      date: e.date,
      startTime: e.start_time,
      endTime: e.end_time,
      durationHours: Math.round(((minutes(e.end_time) - minutes(e.start_time)) / 60) * 100) / 100,
      customer,
      project,
      description,
    });
  }

  // No two entries may cover the same time, whether already in the tracker or
  // in this batch: Jack cannot bill one half hour twice.
  const dates = [...new Set(checked.map((c) => c.date))];
  const existing = (await Promise.all(dates.map((d) =>
    fta.collection("timeEntries").where("date", "==", d).get()
  ))).flatMap((s) => s.docs.map((doc) => ({
    date: doc.get("date") as string,
    startTime: doc.get("startTime") as string,
    endTime: doc.get("endTime") as string,
    description: (doc.get("description") as string | undefined) ?? "(no description)",
  })));
  for (const [i, c] of checked.entries()) {
    const overlaps = (o: {date: string; startTime: string; endTime: string}) =>
      o.date === c.date && minutes(c.startTime) < minutes(o.endTime) && minutes(o.startTime) < minutes(c.endTime);
    const clash = existing.find(overlaps);
    if (clash) {
      problems.push(`${c.date} ${c.startTime}-${c.endTime}: overlaps the entry already in the time tracker at ${clash.startTime}-${clash.endTime} ("${clash.description}").`);
    }
    const twin = checked.slice(0, i).find(overlaps);
    if (twin) {
      problems.push(`${c.date} ${c.startTime}-${c.endTime}: overlaps ${twin.startTime}-${twin.endTime} in this same request.`);
    }
  }

  if (problems.length > 0) {
    return {success: false, posted: 0, error: `Nothing was posted. ${problems.join(" ")}`};
  }

  const summary = checked.map((c) => ({
    date: c.date,
    start: c.startTime,
    end: c.endTime,
    hours: c.durationHours,
    customer: c.customer.companyName,
    project: c.project.projectName,
    description: c.description,
  }));
  const totalHours = Math.round(checked.reduce((n, c) => n + c.durationHours, 0) * 100) / 100;

  if (dryRun) {
    return {success: true, dryRun: true, posted: 0, totalHours, entries: summary};
  }

  const batch = fta.batch();
  const now = new Date();
  const refs = checked.map((c) => {
    const ref = fta.collection("timeEntries").doc();
    batch.set(ref, {
      date: c.date,
      startTime: c.startTime,
      endTime: c.endTime,
      customerId: c.customer.id,
      projectId: c.project.id,
      durationHours: c.durationHours,
      description: c.description,
      status: "unbilled",
      source: "maisie",
      createdAt: now,
      updatedAt: now,
    });
    return ref;
  });

  try {
    await batch.commit();
  } catch (err) {
    return {success: false, posted: 0, error: `Nothing was posted. The time tracker refused the write: ${describeWriteError(err)}`};
  }

  return {
    success: true,
    dryRun: false,
    posted: refs.length,
    totalHours,
    entries: summary.map((s, i) => ({entryId: refs[i].id, ...s})),
  };
}

/** Remove one unbilled entry that Maisie posted. */
export async function deleteTimeEntry(input: {entry_id?: string}): Promise<Record<string, unknown>> {
  const id = (input.entry_id ?? "").trim();
  if (!id) return {success: false, error: "Give the entry_id to delete."};

  const ref = getFtaFirestore().collection("timeEntries").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return {success: false, error: `No time entry has the ID ${id}.`};
  if (snap.get("source") !== "maisie") {
    return {success: false, error: "Maisie did not post this entry, so she will not delete it. Jack can delete it in the time tracker."};
  }
  if (snap.get("status") !== "unbilled") {
    return {success: false, error: `This entry is already ${snap.get("status")} on an invoice, so it cannot be deleted here.`};
  }

  try {
    await ref.delete();
  } catch (err) {
    return {success: false, error: `The time tracker refused the delete: ${describeWriteError(err)}`};
  }
  return {
    success: true,
    deleted: {date: snap.get("date"), start: snap.get("startTime"), end: snap.get("endTime"), description: snap.get("description")},
  };
}

/**
 * Explain a refused write. PERMISSION_DENIED here means the service account
 * can read the tracker's Firestore but not write to it, which is a one-time
 * Google Cloud setting, not a bug Maisie can work around.
 */
function describeWriteError(err: unknown): string {
  const code = (err as {code?: unknown}).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 7 || code === "permission-denied" || /PERMISSION_DENIED/.test(message)) {
    return "Maisie's service account may read the tracker's database but not write to it. " +
      "In Google Cloud project fta-invoice-tracking, give that service account the role " +
      "Cloud Datastore User (roles/datastore.user).";
  }
  return message;
}
