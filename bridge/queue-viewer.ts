/**
 * Desktop Queue Viewer — live terminal UI for pendingDesktopActions.
 *
 * Repointed from pendingCodingTasks, which nothing has written since the
 * code_with_github tool switched to opening GitHub issues.
 *
 * Usage:
 *   cd bridge && npm run queue
 *
 * Press 'q' or Ctrl-C to exit.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.GRPC_SSL_CIPHER_SUITES = "HIGH+ECDSA";

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, "service-account.json"), "utf-8")
);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
db.settings({ preferRest: true });

// ─── ANSI helpers ────────────────────────────────────────────────
const ESC = "\x1b";
const clr = (code: number) => `${ESC}[${code}m`;
const RESET   = clr(0);
const BOLD    = clr(1);
const DIM     = clr(2);
const BLUE    = clr(34);
const GREEN   = clr(32);
const RED     = clr(31);
const YELLOW  = clr(33);
const CYAN    = clr(36);
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR  = `${ESC}[?25l`;
const SHOW_CURSOR  = `${ESC}[?25h`;

// ─── Types ───────────────────────────────────────────────────────
/**
 * Renderer-facing shape. Desktop-action docs are normalized onto this in the
 * snapshot handler below ("applied" -> "completed", appliedAt -> completedAt).
 */
interface CodingTask {
  id: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: Timestamp | null;
  startedAt?: Timestamp | null;
  completedAt?: Timestamp | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

// ─── State ───────────────────────────────────────────────────────
let tasks: CodingTask[] = [];
let lastRender = "";

// ─── Formatting helpers ──────────────────────────────────────────
function elapsed(from: Timestamp | null | undefined, to: Timestamp | null | undefined): string {
  if (!from) return "";
  const endMs = to ? to.toMillis() : Date.now();
  const secs = Math.round((endMs - from.toMillis()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function timeAgo(ts: Timestamp | null | undefined): string {
  if (!ts) return "";
  const secs = Math.round((Date.now() - ts.toMillis()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + "…" : str;
}

function statusIcon(status: CodingTask["status"]): string {
  switch (status) {
    case "pending":   return `${YELLOW}◌${RESET}`;
    case "running":   return `${BLUE}●${RESET}`;
    case "completed": return `${GREEN}✓${RESET}`;
    case "failed":    return `${RED}✗${RESET}`;
  }
}

function statusLabel(status: CodingTask["status"]): string {
  switch (status) {
    case "pending":   return `${YELLOW}${BOLD}PENDING ${RESET}`;
    case "running":   return `${BLUE}${BOLD}RUNNING ${RESET}`;
    case "completed": return `${GREEN}${BOLD}DONE    ${RESET}`;
    case "failed":    return `${RED}${BOLD}FAILED  ${RESET}`;
  }
}

// ─── Render ──────────────────────────────────────────────────────
function render() {
  const cols = process.stdout.columns || 100;
  const innerWidth = cols - 2;
  const lines: string[] = [];

  const border = "─".repeat(innerWidth);
  const header = " Maisie Coding Queue";
  const headerPad = " ".repeat(innerWidth - header.length - 1);
  const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

  lines.push(`┌${border}┐`);
  lines.push(`│${BOLD}${CYAN}${header}${RESET}${headerPad}${DIM}${now}${RESET} │`);
  lines.push(`├${border}┤`);

  if (tasks.length === 0) {
    const empty = "  No tasks in queue.";
    lines.push(`│${DIM}${empty}${" ".repeat(innerWidth - empty.length)}${RESET}│`);
  } else {
    for (const task of tasks) {
      // Row 1: icon + status + task description
      const icon = statusIcon(task.status);
      const label = statusLabel(task.status);
      const descMaxLen = innerWidth - 12; // icon(1) + space + label(8) + space + ellipsis buffer
      const desc = truncate(task.task, descMaxLen);
      const descPad = " ".repeat(Math.max(0, innerWidth - 12 - desc.length));
      lines.push(`│ ${icon} ${label} ${desc}${descPad} │`);

      // Row 2: timing info
      let timeLine = "";
      if (task.status === "pending") {
        timeLine = `${DIM}  Queued ${timeAgo(task.createdAt)}${RESET}`;
      } else if (task.status === "running") {
        timeLine = `${BLUE}  Running for ${elapsed(task.startedAt, null)}…${RESET}`;
      } else if (task.status === "completed") {
        const dur = elapsed(task.startedAt ?? task.createdAt, task.completedAt);
        timeLine = `${DIM}  Took ${dur} · ${RESET}${GREEN}${truncate(summarizeResult(task.result), innerWidth - 20)}${RESET}`;
      } else if (task.status === "failed") {
        const errMsg = String(task.result?.["error"] ?? task.error ?? "Unknown error");
        timeLine = `${RED}  Error: ${truncate(errMsg, innerWidth - 10)}${RESET}`;
      }

      // Strip ANSI for length calculation
      const stripped = timeLine.replace(/\x1b\[[0-9;]*m/g, "");
      const timePad = " ".repeat(Math.max(0, innerWidth - stripped.length));
      lines.push(`│${timeLine}${timePad} │`);

      lines.push(`│${DIM}${"─".repeat(innerWidth)}${RESET}│`);
    }
  }

  lines.push(`└${border}┘`);
  lines.push(`${DIM}  ${tasks.filter(t => t.status === "running").length} running · ${tasks.filter(t => t.status === "completed").length} done · ${tasks.filter(t => t.status === "failed").length} failed · press q to quit${RESET}`);

  const rendered = lines.join("\n");
  // Only redraw if content changed (avoids flicker)
  if (rendered !== lastRender) {
    process.stdout.write(CLEAR_SCREEN + rendered + "\n");
    lastRender = rendered;
  }
}

/** Compact summary of a completed action's result for the detail line. */
function summarizeResult(result: Record<string, unknown> | null | undefined): string {
  if (!result) return "applied";
  if (typeof result["count"] === "number") return `${result["count"]} message(s)`;
  if (result["found"] === false) return "not found";
  if (result["found"] === true) return `read "${result["subject"] ?? ""}"`;
  if (result["sent"] === true) return "sent";
  if (result["sent"] === false) return "draft created";
  if (result["success"] === false) return String(result["error"] ?? "failed");
  return "applied";
}

/** One-line description of a queued desktop action for the list row. */
function describeAction(action: string, payload: Record<string, unknown>): string {
  switch (action) {
  case "mail.search": {
    const bits = [payload["sender"], payload["subject"]].filter(Boolean);
    return `mail.search ${bits.length ? bits.join(" / ") : "(recent)"}`;
  }
  case "mail.read":   return `mail.read ${payload["messageId"] ?? ""}`;
  case "mail.draft":  return `mail.draft "${payload["subject"] ?? ""}"`;
  case "mail.send":   return `mail.send "${payload["subject"] ?? ""}"`;
  case "calendar.create": return `calendar.create "${payload["title"] ?? ""}" ${payload["date"] ?? ""}`;
  case "calendar.move":   return `calendar.move "${payload["eventTitle"] ?? ""}" -> ${payload["newDate"] ?? ""}`;
  default: return action;
  }
}

// ─── Firestore listener ──────────────────────────────────────────
db.collection("pendingDesktopActions")
  .orderBy("createdAt", "desc")
  .limit(20)
  .onSnapshot(
    (snap) => {
      // Adapt desktop-action docs onto the shape the renderer already knows:
      // action+payload become the description, applied/appliedAt map to
      // completed/completedAt.
      tasks = snap.docs.map((d) => {
        const data = d.data();
        const status = data["status"] === "applied" ? "completed" : data["status"];
        return {
          id: d.id,
          task: describeAction(data["action"] ?? "?", (data["payload"] ?? {}) as Record<string, unknown>),
          status,
          createdAt: data["createdAt"] ?? null,
          startedAt: data["startedAt"] ?? null,
          completedAt: data["appliedAt"] ?? null,
          result: data["result"] ?? null,
          error: data["error"] ?? null,
        } as CodingTask;
      });
      render();
    },
    (err) => {
      process.stdout.write(`${RED}Firestore error: ${err.message}${RESET}\n`);
    }
  );

// ─── Tick for elapsed time on running tasks ───────────────────────
setInterval(() => {
  if (tasks.some(t => t.status === "running" || t.status === "pending")) {
    render();
  }
}, 1000);

// ─── Input handling ───────────────────────────────────────────────
process.stdout.write(HIDE_CURSOR);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key: Buffer) => {
    const k = key.toString();
    if (k === "q" || k === "\u0003") { // q or Ctrl-C
      process.stdout.write(SHOW_CURSOR + "\n");
      process.exit(0);
    }
  });
}

process.on("exit", () => process.stdout.write(SHOW_CURSOR));
process.on("SIGINT", () => { process.stdout.write(SHOW_CURSOR + "\n"); process.exit(0); });
