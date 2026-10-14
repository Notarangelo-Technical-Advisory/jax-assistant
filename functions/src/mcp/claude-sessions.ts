/**
 * Read when Jack worked in Claude Code, for the work journal, from the session
 * files Claude Code keeps in ~/.claude/projects (one JSON line per message).
 *
 * Only the times, the repo, the branch, the number of prompts Jack typed and
 * the short title Claude Code gives each session (the one in its session list)
 * are passed on. Prompts and replies are not.
 *
 * A session is split into work spans wherever it was idle for more than
 * GAP_MINUTES or moved to another repo or branch, so a session left open
 * overnight does not count as a night's work. A span counts only when Jack
 * typed at least one prompt in it: a background task finishing, or a long tool
 * run picking up again after a pause, is the session working, not Jack.
 */

import {execFileSync} from "child_process";
import {existsSync, readdirSync, readFileSync, statSync} from "fs";
import {homedir} from "os";
import {basename, join} from "path";
import {GAP_MINUTES, JournalItemInput, ticketInBranch} from "../tools/journal";

/**
 * A Claude Code scratch folder, /tmp/claude-501/<the session's own folder,
 * with every character other than a letter or digit made "-">/<id>/scratchpad.
 */
const SCRATCHPAD = /^(?:\/private)?\/tmp\/claude-\d+\/(-[^/]+)\//;

interface Activity {
  at: number;
  cwd: string;
  branch: string;
  prompt: boolean;
}

export interface ClaudeSessions {
  files: number;
  items: JournalItemInput[];
  /** Spans left out: no prompt from Jack, or from an automated (SDK) run. */
  skipped: number;
}

/**
 * The folder a Claude Code folder name such as "-Users-jack-Documents-GitHub-cmsonline"
 * stands for, found by walking down from `dir`, or null. Longer names are tried
 * first, so "fractional-tech-advisory" is not read as "fractional".
 */
export function decodeFolderName(encoded: string, dir = "/"): string | null {
  if (!encoded) return dir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => b.length - a.length)) {
    const part = "-" + entry.replace(/[^A-Za-z0-9]/g, "-");
    if (encoded !== part && !encoded.startsWith(part + "-")) continue;
    const found = decodeFolderName(encoded.slice(part.length), join(dir, entry));
    if (found) return found;
  }
  return null;
}

/** "owner/name" of the GitHub repo a folder belongs to, or null. */
export function repoOf(cwd: string, cache = new Map<string, string | null>()): string | null {
  // A scratch folder belongs to the repo of the session that made it.
  const scratch = cwd.match(SCRATCHPAD)?.[1];
  const from = scratch ? decodeFolderName(scratch) ?? cwd : cwd;
  // A worktree that has since been removed still names its repo in its path.
  const dir = existsSync(from) ? from : from.replace(/\/\.claude\/worktrees\/.*$/, "");
  if (cache.has(dir)) return cache.get(dir)!;
  let repo: string | null = null;
  try {
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"]}).trim();
    repo = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    repo = null;
  }
  cache.set(dir, repo);
  return repo;
}

/** True for a line Jack typed, not a tool result or a message Claude Code added. */
function isPrompt(line: Record<string, unknown>): boolean {
  if (line["type"] !== "user" || line["isMeta"] === true) return false;
  const content = (line["message"] as {content?: unknown} | undefined)?.content;
  if (typeof content === "string") return !content.startsWith("<");
  if (!Array.isArray(content)) return false;
  return content.some((c) => c?.type === "text") && !content.some((c) => c?.type === "tool_result");
}

/** One session file's activity and title. */
export function parseSession(raw: string): {sessionId: string; title: string; activity: Activity[]; automated: boolean} {
  let sessionId = "";
  let title = "";
  let customTitle = "";
  let automated = false;
  const activity: Activity[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(text);
    } catch {
      continue; // A line still being written.
    }
    if (typeof line["sessionId"] === "string" && !sessionId) sessionId = line["sessionId"];
    if (line["type"] === "ai-title" && typeof line["aiTitle"] === "string") title = line["aiTitle"];
    if (line["type"] === "custom-title" && typeof line["customTitle"] === "string") customTitle = line["customTitle"];
    if (line["type"] !== "user" && line["type"] !== "assistant") continue;
    if (line["isSidechain"] === true) continue;
    if (typeof line["entrypoint"] === "string" && line["entrypoint"].startsWith("sdk")) automated = true;
    const at = Date.parse(String(line["timestamp"] ?? ""));
    const cwd = typeof line["cwd"] === "string" ? line["cwd"] : "";
    if (!Number.isFinite(at) || !cwd) continue;
    activity.push({at, cwd, branch: typeof line["gitBranch"] === "string" ? line["gitBranch"] : "", prompt: isPrompt(line)});
  }
  activity.sort((a, b) => a.at - b.at);
  return {sessionId, title: customTitle || title, activity, automated};
}

/** Split a session's activity into spans of continuous work in one folder and branch. */
export function workSpans(activity: Activity[]): Activity[][] {
  const spans: Activity[][] = [];
  for (const a of activity) {
    const span = spans[spans.length - 1];
    const last = span?.[span.length - 1];
    if (last && a.at - last.at <= GAP_MINUTES * 60_000 && a.cwd === last.cwd && a.branch === last.branch) {
      span.push(a);
    } else {
      spans.push([a]);
    }
  }
  return spans;
}

/** Claude Code work that went on at or after `since`. */
export function readClaudeSessions(since: Date, root = process.env.MAISIE_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects")): ClaudeSessions {
  const result: ClaudeSessions = {files: 0, items: [], skipped: 0};
  if (!existsSync(root)) return result;
  const repos = new Map<string, string | null>();
  for (const project of readdirSync(root, {withFileTypes: true})) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      if (statSync(path).mtimeMs < since.getTime()) continue;
      result.files++;
      const session = parseSession(readFileSync(path, "utf-8"));
      const sessionId = session.sessionId || basename(file, ".jsonl");
      for (const span of workSpans(session.activity)) {
        const first = span[0];
        const last = span[span.length - 1];
        if (last.at < since.getTime()) continue;
        const prompts = span.filter((a) => a.prompt).length;
        if (!prompts || session.automated) {
          result.skipped++;
          continue;
        }
        const repo = repoOf(first.cwd, repos);
        const where = repo?.split("/")[1] ?? basename(first.cwd);
        result.items.push({
          source: "claude",
          sourceId: `${sessionId}:${new Date(first.at).toISOString()}`,
          at: new Date(first.at).toISOString(),
          endAt: new Date(last.at).toISOString(),
          action: `Claude Code in ${where}`,
          subject: session.title || (first.branch ? `${where} on ${first.branch}` : where),
          detail: [first.branch, `${prompts} prompt${prompts === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
          repo,
          ticket: ticketInBranch(first.branch),
        });
      }
    }
  }
  return result;
}
