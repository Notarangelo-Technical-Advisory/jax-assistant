import * as admin from "firebase-admin";
import {
  getUnbilledEntries,
  getTimeEntriesForRange,
  getInvoices,
} from "../fta-client";
import {readCalendarEvents, formatEventTime, extractMeetingLink, extractPasscode} from "./calendar-read";
import {Category, DEFAULT_CATEGORY_KEYS} from "./definitions";

export interface CustomerInfo {
  name: string;
  rate: number;
}

export interface ToolContext {
  db: admin.firestore.Firestore;
  /** Keyed by the Firestore doc ID that time entries store as customerId. */
  customerMap: Map<string, CustomerInfo>;
  /**
   * Mutated in place by create_task_category / delete_task_category. Callers
   * must rebuild tool schemas when onCategoriesChanged fires, because
   * add_task's category enum is derived from this list.
   */
  categories: Category[];
  /** Progress hook — the cloud writes to chatThinking, the MCP server no-ops. */
  onStep?: (step: string, tool: string) => Promise<void> | void;
  /** Fired after `categories` is mutated so the caller can rebuild schemas. */
  onCategoriesChanged?: () => void;
}

/** How long a cloud tool waits for the desktop bridge before giving up. */
const DESKTOP_ACTION_TIMEOUT_MS = 40_000;
const DESKTOP_POLL_INTERVAL_MS = 1_500;

/**
 * Queue an action for the local desktop bridge and wait for its result.
 *
 * The bridge polls every 30s via launchd, so a cold queue can take that long;
 * the chat function has a 300s budget, so waiting ~40s is safe. On timeout the
 * action stays queued and will still be applied — the caller just reports back
 * without the result.
 */
async function queueAndAwaitDesktopAction(
  db: admin.firestore.Firestore,
  action: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const ref = await db.collection("pendingDesktopActions").add({
    action,
    status: "pending",
    payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    startedAt: null,
    appliedAt: null,
    result: null,
    error: null,
  });

  const deadline = Date.now() + DESKTOP_ACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, DESKTOP_POLL_INTERVAL_MS));
    const snap = await ref.get();
    const data = snap.data();
    const status = data?.["status"];
    if (status === "applied") {
      return {success: true, ...(data?.["result"] as Record<string, unknown>)};
    }
    if (status === "failed") {
      return {success: false, error: data?.["error"] ?? "Desktop action failed."};
    }
  }

  return {
    success: false,
    pending: true,
    actionId: ref.id,
    error: "The desktop bridge did not respond in time. The action is still queued and will run when Jack's Mac picks it up — tell him it is pending rather than failed, and that his Mac may be asleep or the bridge may not be running.",
  };
}

/**
 * Execute one MAISIE tool and return the raw result object. Callers are
 * responsible for JSON.stringify — the Anthropic tool loop needs a string,
 * MCP wants structured content.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const {db, customerMap, categories} = ctx;

  switch (name) {
  // ─── Calendar (Firestore mirror) ─────────────────────────────
  case "get_calendar": {
    const input = rawInput as {days_ahead?: number};
    const daysAhead = input.days_ahead || 1;
    const calStart = new Date();
    calStart.setHours(0, 0, 0, 0);
    const calEnd = new Date(calStart);
    calEnd.setDate(calEnd.getDate() + daysAhead);
    const events = await readCalendarEvents(db, calStart, calEnd).catch(() => []);
    const formatted = events.map((e) => {
      const day = e.startTime.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York"});
      const time = `${formatEventTime(e.startTime)}–${formatEventTime(e.endTime)}`;
      const cal = e.calendarName ? `[${e.calendarName}] ` : "";
      // The join link is the answer to "how do I get into this meeting", so
      // surface it here rather than making the model ask for the invite body.
      const link = extractMeetingLink(e.notes);
      const passcode = extractPasscode(e.notes);
      const join = link
        ? ` — join: ${link}${passcode ? ` (passcode ${passcode})` : ""}`
        : "";
      return `${day} ${time}: ${cal}${e.summary}${e.location ? ` (${e.location})` : ""}${join}`;
    });
    return {
      events: formatted,
      count: events.length,
      range: `Next ${daysAhead} day(s)`,
    };
  }

  // ─── Tasks ───────────────────────────────────────────────────
  case "add_task": {
    const input = rawInput as {title: string; category: string; dueDate?: string};
    const docRef = await db.collection("tasks").add({
      title: input.title,
      category: input.category,
      completed: false,
      dueDate: input.dueDate || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {success: true, taskId: docRef.id};
  }

  case "complete_task": {
    const input = rawInput as {taskId: string};
    await db.collection("tasks").doc(input.taskId).update({
      completed: true,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {success: true};
  }

  case "reopen_task": {
    const input = rawInput as {taskId: string};
    await db.collection("tasks").doc(input.taskId).update({
      completed: false,
      completedAt: admin.firestore.FieldValue.delete(),
    });
    return {success: true};
  }

  case "update_task": {
    const input = rawInput as {taskId: string; dueDate?: string | null; title?: string};
    const updates: Record<string, unknown> = {};
    if (input.title !== undefined) updates["title"] = input.title;
    if (input.dueDate !== undefined) updates["dueDate"] = input.dueDate ?? null;
    await db.collection("tasks").doc(input.taskId).update(updates);
    return {success: true};
  }

  case "create_task_category": {
    const input = rawInput as {key: string; label: string};
    const sanitizedKey = input.key.toLowerCase().replace(/[^a-z0-9-_]/g, "");
    const isDefault = DEFAULT_CATEGORY_KEYS.includes(sanitizedKey);
    const existingSnap = await db.collection("taskCategories")
      .where("key", "==", sanitizedKey).limit(1).get();
    if (isDefault || !existingSnap.empty) {
      return {success: false, error: `Category "${sanitizedKey}" already exists.`};
    }
    const orderSnap = await db.collection("taskCategories")
      .orderBy("order", "desc").limit(1).get();
    const existingOrders = orderSnap.docs.map((d) => (d.data()["order"] as number) ?? 0);
    const maxOrder = existingOrders.length > 0 ? Math.max(...existingOrders) + 1 : 100;
    await db.collection("taskCategories").add({
      key: sanitizedKey,
      label: input.label,
      order: maxOrder,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Keep the in-memory list current so subsequent add_task calls accept the
    // new key, then let the caller rebuild the tool schemas.
    categories.push({key: sanitizedKey, label: input.label});
    ctx.onCategoriesChanged?.();
    return {success: true, key: sanitizedKey, label: input.label};
  }

  case "delete_task_category": {
    const input = rawInput as {key: string};
    const sanitizedKey = input.key.toLowerCase().replace(/[^a-z0-9-_]/g, "");
    if (DEFAULT_CATEGORY_KEYS.includes(sanitizedKey)) {
      return {success: false, error: `"${input.key}" is a built-in category and cannot be deleted.`};
    }
    const activeTasksSnap = await db.collection("tasks")
      .where("category", "==", sanitizedKey)
      .where("completed", "==", false)
      .get();
    if (!activeTasksSnap.empty) {
      return {
        success: false,
        error: `Cannot delete category "${sanitizedKey}" — it has ${activeTasksSnap.size} active task(s). Complete or reassign those tasks first.`,
        activeTasks: activeTasksSnap.docs.map((d) => ({id: d.id, title: d.data()["title"]})),
      };
    }
    const catSnap = await db.collection("taskCategories")
      .where("key", "==", sanitizedKey).limit(1).get();
    if (catSnap.empty) {
      return {success: false, error: `Category "${sanitizedKey}" not found.`};
    }
    await catSnap.docs[0].ref.delete();
    const idx = categories.findIndex((c) => c.key === sanitizedKey);
    if (idx !== -1) categories.splice(idx, 1);
    ctx.onCategoriesChanged?.();
    return {success: true, key: sanitizedKey};
  }

  // ─── Billing (NTA time tracker: fta-invoice-tracking) ────────
  case "get_unbilled_detail": {
    const input = rawInput as {customer_id?: string};
    const entries = await getUnbilledEntries(input.customer_id).catch(() => []);

    const grouped: Record<string, {
      customerName: string;
      projects: Record<string, {hours: number; amount: number; entries: Array<{date: string; hours: number; description: string}>}>;
      totalHours: number;
      totalAmount: number;
    }> = {};

    for (const entry of entries) {
      const custInfo = customerMap.get(entry.customerId);
      if (!grouped[entry.customerId]) {
        grouped[entry.customerId] = {
          customerName: custInfo?.name || entry.customerId,
          projects: {},
          totalHours: 0,
          totalAmount: 0,
        };
      }
      const cust = grouped[entry.customerId];
      const rate = custInfo?.rate ?? 150;
      if (!cust.projects[entry.projectId]) {
        cust.projects[entry.projectId] = {hours: 0, amount: 0, entries: []};
      }
      cust.projects[entry.projectId].hours += entry.durationHours;
      cust.projects[entry.projectId].amount += entry.durationHours * rate;
      cust.projects[entry.projectId].entries.push({
        date: entry.date,
        hours: entry.durationHours,
        description: entry.description || "(no description)",
      });
      cust.totalHours += entry.durationHours;
      cust.totalAmount += entry.durationHours * rate;
    }

    const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
    return {
      totalUnbilledHours: totalHours,
      totalUnbilledAmount: totalHours * 150,
      entryCount: entries.length,
      customers: grouped,
    };
  }

  case "get_time_entries": {
    const input = rawInput as {
      days_back?: number;
      start_date?: string;
      end_date?: string;
      customer_id?: string;
    };

    const todayStr = new Date().toISOString().split("T")[0];
    let startDate: string;
    let endDate: string;

    if (input.start_date) {
      startDate = input.start_date;
      endDate = input.end_date || todayStr;
    } else {
      const daysBack = input.days_back ?? 7;
      const start = new Date();
      start.setDate(start.getDate() - daysBack);
      startDate = start.toISOString().split("T")[0];
      endDate = todayStr;
    }

    const entries = await getTimeEntriesForRange(startDate, endDate, input.customer_id).catch(() => []);

    const grouped: Record<string, {
      customerName: string;
      projects: Record<string, {hours: number; entries: Array<{date: string; hours: number; description: string; status: string}>}>;
      totalHours: number;
    }> = {};

    for (const entry of entries) {
      const custInfo = customerMap.get(entry.customerId);
      if (!grouped[entry.customerId]) {
        grouped[entry.customerId] = {
          customerName: custInfo?.name || entry.customerId,
          projects: {},
          totalHours: 0,
        };
      }
      const cust = grouped[entry.customerId];
      if (!cust.projects[entry.projectId]) {
        cust.projects[entry.projectId] = {hours: 0, entries: []};
      }
      cust.projects[entry.projectId].hours += entry.durationHours;
      cust.projects[entry.projectId].entries.push({
        date: entry.date,
        hours: entry.durationHours,
        description: entry.description || "(no description)",
        status: entry.status,
      });
      cust.totalHours += entry.durationHours;
    }

    const totalHours = entries.reduce((sum, e) => sum + e.durationHours, 0);
    return {
      dateRange: {startDate, endDate},
      totalHours,
      entryCount: entries.length,
      customers: grouped,
    };
  }

  case "get_invoice_status": {
    const input = rawInput as {customer_id?: string; status_filter?: "all" | "unpaid" | "paid"};
    const statusFilter = input.status_filter || "all";
    const invoiceStatusOpt = statusFilter === "all" ? undefined :
      statusFilter === "paid" ? "paid" as const : "unpaid" as const;

    const [invoices, unbilledForStatus] = await Promise.all([
      getInvoices({customerId: input.customer_id, status: invoiceStatusOpt, limit: 20}).catch(() => []),
      statusFilter !== "paid"
        ? getUnbilledEntries(input.customer_id).catch(() => [])
        : Promise.resolve([]),
    ]);

    const readyToInvoice: Record<string, {customerName: string; hours: number; amount: number}> = {};
    for (const entry of unbilledForStatus) {
      const custInfo = customerMap.get(entry.customerId);
      if (!readyToInvoice[entry.customerId]) {
        readyToInvoice[entry.customerId] = {
          customerName: custInfo?.name || entry.customerId,
          hours: 0,
          amount: 0,
        };
      }
      const rate = custInfo?.rate ?? 150;
      readyToInvoice[entry.customerId].hours += entry.durationHours;
      readyToInvoice[entry.customerId].amount += entry.durationHours * rate;
    }

    const formattedInvoices = invoices.map((inv) => ({
      invoiceNumber: inv.invoiceNumber,
      customer: inv.customerName || customerMap.get(inv.customerId)?.name || inv.customerId,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      total: inv.total,
      status: inv.status,
    }));

    return {
      invoices: formattedInvoices,
      invoiceCount: invoices.length,
      readyToInvoice: Object.keys(readyToInvoice).length > 0 ? readyToInvoice : null,
    };
  }

  // ─── Calendar writes (queued for the desktop bridge) ─────────
  case "create_calendar_event": {
    const input = rawInput as {
      title: string;
      date: string;
      start_time: string;
      end_time: string;
      location?: string;
      notes?: string;
    };
    const actionRef = await db.collection("pendingCalendarActions").add({
      action: "create",
      status: "pending",
      payload: {
        title: input.title,
        date: input.date,
        startTime: input.start_time,
        endTime: input.end_time,
        location: input.location || null,
        notes: input.notes || null,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      appliedAt: null,
      error: null,
    });
    return {
      success: true,
      actionId: actionRef.id,
      message: `Calendar event "${input.title}" on ${input.date} at ${input.start_time}–${input.end_time} has been queued. It will appear on the calendar within ~1 minute once the bridge syncs.`,
    };
  }

  case "move_calendar_event": {
    const input = rawInput as {
      event_title: string;
      original_date: string;
      new_date: string;
      new_start_time: string;
      new_end_time: string;
    };
    const actionRef = await db.collection("pendingCalendarActions").add({
      action: "move",
      status: "pending",
      payload: {
        eventTitle: input.event_title,
        originalDate: input.original_date,
        newDate: input.new_date,
        newStartTime: input.new_start_time,
        newEndTime: input.new_end_time,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      appliedAt: null,
      error: null,
    });
    return {
      success: true,
      actionId: actionRef.id,
      message: `"${input.event_title}" has been queued to move from ${input.original_date} to ${input.new_date} at ${input.new_start_time}–${input.new_end_time}. The change will appear within ~1 minute once the bridge syncs.`,
    };
  }

  // ─── Desktop reach (queued to the local bridge) ──────────────
  // Cloud-only: in VS Code the desktop MCP server does these directly.
  // There is deliberately no mail_send here — the cloud can compose, only
  // Jack sends, from VS Code where he can see it.
  case "mail_search": {
    const input = rawInput as {sender?: string; subject?: string; days_back?: number; limit?: number};
    return queueAndAwaitDesktopAction(db, "mail.search", {
      sender: input.sender ?? null,
      subject: input.subject ?? null,
      daysBack: input.days_back ?? 7,
      limit: input.limit ?? 15,
    });
  }

  case "mail_read": {
    const input = rawInput as {message_id: string};
    return queueAndAwaitDesktopAction(db, "mail.read", {
      messageId: input.message_id,
    });
  }

  case "mail_draft": {
    const input = rawInput as {to: string[]; subject: string; body: string; cc?: string[]};
    return queueAndAwaitDesktopAction(db, "mail.draft", {
      to: input.to,
      subject: input.subject,
      body: input.body,
      cc: input.cc ?? null,
    });
  }

  // ─── Coding delegation ───────────────────────────────────────
  case "code_with_github": {
    const input = rawInput as {task: string};
    const githubPat = process.env.MAISIE_PAT;
    if (!githubPat) {
      return {success: false, error: "MAISIE_PAT is not configured in the Cloud Functions environment. Ask Jack to add it via Firebase secrets."};
    }

    const issueTitle = input.task.split("\n")[0].substring(0, 100);
    const issueBody = `@claude\n\n${input.task}`;

    await ctx.onStep?.("Submitting task to cloud coding agent...", "code_with_github");

    const ghResponse = await fetch(
      "https://api.github.com/repos/Notarangelo-Technical-Advisory/jax-assistant/issues",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${githubPat}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({title: issueTitle, body: issueBody, labels: ["coding-task"]}),
      }
    );

    if (!ghResponse.ok) {
      const errText = await ghResponse.text();
      return {success: false, error: `GitHub API error ${ghResponse.status}: ${errText}`};
    }
    const issue = await ghResponse.json() as {html_url: string; number: number};
    return {
      success: true,
      issue_url: issue.html_url,
      issue_number: issue.number,
      message: "Task submitted to cloud coding agent. Jack will get a GitHub notification when the PR is ready.",
    };
  }

  // ─── Google Maps ─────────────────────────────────────────────
  case "search_place": {
    const input = rawInput as {query: string};
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleApiKey) {
      return {error: "GOOGLE_MAPS_API_KEY is not configured. Add it as a GitHub secret (GOOGLE_MAPS_API_KEY) and redeploy."};
    }
    try {
      const placesResp = await fetch(
        "https://places.googleapis.com/v1/places:searchText",
        {
          method: "POST",
          headers: {
            "X-Goog-Api-Key": googleApiKey,
            "X-Goog-Field-Mask": "places.displayName,places.formattedAddress,places.currentOpeningHours,places.regularOpeningHours,places.businessStatus",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({textQuery: input.query}),
        }
      );
      if (!placesResp.ok) {
        const errText = await placesResp.text();
        return {error: `Google Places API error ${placesResp.status}: ${errText}`};
      }
      type PlacesResult = {
        places?: Array<{
          displayName?: {text: string};
          formattedAddress?: string;
          businessStatus?: string;
          currentOpeningHours?: {openNow?: boolean; weekdayDescriptions?: string[]};
          regularOpeningHours?: {weekdayDescriptions?: string[]};
        }>;
      };
      const placesData = await placesResp.json() as PlacesResult;
      if (!placesData.places || placesData.places.length === 0) {
        return {found: false, message: `No results found for "${input.query}"`};
      }
      const place = placesData.places[0];
      const hours = place.currentOpeningHours?.weekdayDescriptions ||
                    place.regularOpeningHours?.weekdayDescriptions || [];
      return {
        found: true,
        name: place.displayName?.text || input.query,
        address: place.formattedAddress || "Address not available",
        currently_open: place.currentOpeningHours?.openNow ?? null,
        business_status: place.businessStatus || "OPERATIONAL",
        hours,
      };
    } catch (e) {
      return {error: `Failed to call Google Places API: ${(e as Error).message}`};
    }
  }

  case "get_directions": {
    const input = rawInput as {origin: string; destination: string};
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!googleApiKey) {
      return {error: "GOOGLE_MAPS_API_KEY is not configured. Add it as a GitHub secret (GOOGLE_MAPS_API_KEY) and redeploy."};
    }
    try {
      const encodedOrigin = encodeURIComponent(input.origin);
      const encodedDest = encodeURIComponent(input.destination);
      type DistanceMatrixResponse = {
        status: string;
        rows?: Array<{elements: Array<{status: string; distance?: {text: string}; duration?: {text: string}}>}>;
        error_message?: string;
      };
      const [drivingResp, walkingResp] = await Promise.all([
        fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodedOrigin}&destinations=${encodedDest}&mode=driving&key=${googleApiKey}`),
        fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodedOrigin}&destinations=${encodedDest}&mode=walking&key=${googleApiKey}`),
      ]);
      const [drivingData, walkingData] = await Promise.all([
        drivingResp.json() as Promise<DistanceMatrixResponse>,
        walkingResp.json() as Promise<DistanceMatrixResponse>,
      ]);
      const drivingEl = drivingData.rows?.[0]?.elements?.[0];
      const walkingEl = walkingData.rows?.[0]?.elements?.[0];
      const result: Record<string, unknown> = {
        origin: input.origin,
        destination: input.destination,
      };
      if (drivingEl?.status === "OK") {
        result["driving_distance"] = drivingEl.distance?.text;
        result["driving_time"] = drivingEl.duration?.text;
      } else {
        result["driving"] = drivingData.error_message || "Driving route not available";
      }
      if (walkingEl?.status === "OK") {
        result["walking_distance"] = walkingEl.distance?.text;
        result["walking_time"] = walkingEl.duration?.text;
      } else {
        result["walking"] = walkingData.error_message || "Walking route not available";
      }
      return result;
    } catch (e) {
      return {error: `Failed to call Google Maps API: ${(e as Error).message}`};
    }
  }

  default:
    return {error: `Unknown tool "${name}".`};
  }
}

/** Human-readable progress label for each tool call. */
export const toolLabel = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
  case "get_calendar": return "Checking your calendar...";
  case "add_task": return `Adding task: "${input["title"]}"`;
  case "complete_task": return "Marking task complete...";
  case "reopen_task": return "Reopening task...";
  case "update_task": return "Updating task...";
  case "create_task_category": return `Creating category "${input["label"]}"...`;
  case "delete_task_category": return `Deleting category "${input["key"]}"...`;
  case "get_unbilled_detail": return "Fetching unbilled time entries...";
  case "get_time_entries": return "Loading time log...";
  case "get_invoice_status": return "Checking invoice status...";
  case "create_calendar_event": return `Scheduling "${input["title"]}"...`;
  case "move_calendar_event": return `Rescheduling "${input["event_title"]}"...`;
  case "mail_search": return "Searching your mail...";
  case "mail_read": return "Opening the message...";
  case "mail_draft": return `Drafting "${input["subject"]}"...`;
  case "code_with_github": return "Sending task to coding agent...";
  case "search_place": return `Looking up "${input["query"]}"...`;
  case "get_directions": return `Getting directions from ${input["origin"]} to ${input["destination"]}...`;
  default: return `Running ${name}...`;
  }
};
