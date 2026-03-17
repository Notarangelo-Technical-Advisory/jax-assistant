/**
 * Coding Queue Viewer — live terminal UI for pendingCodingTasks.
 *
 * Usage:
 *   cd bridge && npx tsx queue-viewer.ts
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
interface CodingTask {
  id: string;
  task: string;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: Timestamp | null;
  startedAt?: Timestamp | null;
  completedAt?: Timestamp | null;
  result?: { success: boolean; pr_url?: string; error?: string; summary?: string } | null;
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
        const prUrl = task.result?.pr_url;
        if (prUrl) {
          timeLine = `${DIM}  Took ${dur} · ${RESET}${GREEN}PR: ${prUrl}${RESET}`;
        } else {
          timeLine = `${DIM}  Took ${dur} · no PR URL captured${RESET}`;
        }
      } else if (task.status === "failed") {
        const errMsg = task.result?.error ?? task.error ?? "Unknown error";
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

// ─── Firestore listener ──────────────────────────────────────────
db.collection("pendingCodingTasks")
  .orderBy("createdAt", "desc")
  .limit(20)
  .onSnapshot(
    (snap) => {
      tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() } as CodingTask));
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
