/**
 * Read when Jack worked in Claude Code, for the work journal, from the session
 * files Claude Code keeps in ~/.claude/projects (one JSON line per message).
 *
 * Only the times, the repo, the branch, the number of prompts Jack typed and
 * the short title Claude Code gives each session (the one in its session list)
 * are passed on. Prompts and replies are not.
 *
 * A session is split into stretches of work wherever it was idle for more
 * than GAP_MINUTES, so a session left open overnight does not count as a
 * night's work, and each stretch into spans wherever it moved to another
 * folder or branch, so each span has one repo and branch. A span counts only
 * when its stretch has at least one prompt from Jack: a background task
 * finishing, or a long tool run picking up again after a pause, is the session
 * working, not Jack. Work that moves to another folder or branch after his
 * prompt, with no pause, is still his.
 *
 * A span in a folder that is in no repo, such as the folder above the repos or
 * Claude Code's own memory folder, takes the repo the session was started in,
 * so the journal gives it that repo's client and not General.
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
  /** Spans left out: no prompt from Jack in their stretch of work, or from an automated (SDK) run. */
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

/**
 * "owner/name" of the repo a session was started in, from the folder name
 * Claude Code files it under, or null. A removed worktree is filed under its
 * own name, so the repo's name is used.
 */
export function homeRepoOf(projectName: string, cache = new Map<string, string | null>()): string | null {
  const dir = decodeFolderName(projectName.replace(/--claude-worktrees-.*$/, ""));
  return dir ? repoOf(dir, cache) : null;
}

/**
 * The repo of each span. A span in no repo takes the session's home repo, and
 * when that is none, the repo that most of the session's activity was in.
 */
export function spanRepos(spans: Activity[][], home: string | null, repoFor: (cwd: string) => string | null): Array<string | null> {
  const own = spans.map((span) => repoFor(span[0].cwd));
  const activity = new Map<string, number>();
  own.forEach((repo, i) => {
    if (repo) activity.set(repo, (activity.get(repo) ?? 0) + spans[i].length);
  });
  const mostActive = [...activity.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return own.map((repo) => repo ?? home ?? mostActive);
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

/**
 * For each span from workSpans, whether the stretch of work it belongs to (the
 * spans with no more than GAP_MINUTES idle between them) has a prompt from Jack.
 */
export function promptedSpans(spans: Activity[][]): boolean[] {
  const stretches: number[] = [];
  const prompted = new Set<number>();
  let stretch = -1;
  spans.forEach((span, i) => {
    const before = spans[i - 1];
    if (!before || span[0].at - before[before.length - 1].at > GAP_MINUTES * 60_000) stretch++;
    stretches.push(stretch);
    if (span.some((a) => a.prompt)) prompted.add(stretch);
  });
  return stretches.map((s) => prompted.has(s));
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
    const home = homeRepoOf(project.name, repos);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      if (statSync(path).mtimeMs < since.getTime()) continue;
      result.files++;
      const session = parseSession(readFileSync(path, "utf-8"));
      const sessionId = session.sessionId || basename(file, ".jsonl");
      const spans = workSpans(session.activity);
      const prompted = promptedSpans(spans);
      const spanRepo = spanRepos(spans, home, (cwd) => repoOf(cwd, repos));
      for (const [i, span] of spans.entries()) {
        const first = span[0];
        const last = span[span.length - 1];
        if (last.at < since.getTime()) continue;
        const prompts = span.filter((a) => a.prompt).length;
        if (!prompted[i] || session.automated) {
          result.skipped++;
          continue;
        }
        const repo = spanRepo[i];
        const where = repo?.split("/")[1] ?? basename(first.cwd);
        result.items.push({
          source: "claude",
          sourceId: `${sessionId}:${new Date(first.at).toISOString()}`,
          at: new Date(first.at).toISOString(),
          endAt: new Date(last.at).toISOString(),
          action: `Claude Code in ${where}`,
          subject: session.title || (first.branch ? `${where} on ${first.branch}` : where),
          detail: [first.branch, prompts ? `${prompts} prompt${prompts === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "),
          repo,
          ticket: ticketInBranch(first.branch),
        });
      }
    }
  }
  return result;
}
