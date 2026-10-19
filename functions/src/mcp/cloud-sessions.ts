/**
 * Claude Code sessions Jack runs in the cloud (from his phone, the web or the
 * desktop app), for the work journal. Their files never reach his Mac, so
 * claude-sessions.ts cannot see them.
 *
 * Two halves:
 *   - exportCloudDays, run each night by a scheduled cloud task: from the
 *     session list and the sessions' message records, it keeps only each
 *     session's id, title, where it ran, its repo and the time of each event,
 *     marking the messages Jack typed. Never the messages themselves. The
 *     result is one file per Eastern Time day, pushed to the journal-data
 *     branch of the private fractional-tech-advisory repo (jax-assistant is
 *     public, and the titles name client work).
 *   - readCloudSessions, run by the journal job on the Mac: reads those files
 *     with gh and turns each stretch of a session's work into a journal item,
 *     as claude-sessions.ts does for a session on the Mac.
 *
 * A message counts as Jack's when the record says which device it came from
 * (client_platform, such as "ios"). Tool results, and messages a schedule or
 * another session delivers, carry no device. A session tagged journal:skip,
 * such as the nightly task's own, is left out.
 */

import {GAP_MINUTES, JournalItemInput, ticketInBranch} from "../tools/journal";
import {etDateKey} from "../et-time";
import {GhApi, githubApi} from "./github-activity";

export const CLOUD_DATA_REPO = "Notarangelo-Technical-Advisory/fractional-tech-advisory";
export const CLOUD_DATA_BRANCH = "journal-data";
export const CLOUD_DATA_DIR = "journal/cloud-sessions";
export const SKIP_TAG = "journal:skip";

/** One session as the session list describes it; only the fields used here. */
export interface ListedSession {
  id: string;
  title?: string;
  origin?: string;
  environment_kind?: string;
  tags?: string[];
  session_context?: {
    sources?: Array<{git_repository?: {url?: string}}>;
    outcomes?: Array<{git_repository?: {git_info?: {repo?: string; branches?: string[]}}}>;
  };
}

/** One event from a session's record of user-side messages. */
export interface RecordedEvent {
  created_at?: string;
  user?: Record<string, unknown>;
}

/** A session's day in the exported file: times only, with 1 for a message Jack typed. */
export interface CloudSessionDay {
  id: string;
  title: string;
  origin: string;
  repo: string | null;
  branch: string | null;
  events: Array<[string, 0 | 1]>;
}

export interface CloudDayFile {
  day: string;
  sessions: CloudSessionDay[];
}

/** "IHRDC/cmsonline" from "https://github.com/IHRDC/cmsonline(.git)". */
function repoFromUrl(url: unknown): string | null {
  const m = typeof url === "string" ? url.match(/github\.com\/([^/]+\/[^/.]+)/i) : null;
  return m ? m[1] : null;
}

/** The repo the session worked in: the one it made a branch in, else the first it was given. */
export function sessionRepo(s: ListedSession): {repo: string | null; branch: string | null} {
  const outcomes = s.session_context?.outcomes ?? [];
  const worked = outcomes.find((o) => o.git_repository?.git_info?.branches?.length);
  if (worked?.git_repository?.git_info?.repo) {
    return {repo: worked.git_repository.git_info.repo, branch: worked.git_repository.git_info.branches?.[0] ?? null};
  }
  const first = s.session_context?.sources?.map((x) => repoFromUrl(x.git_repository?.url)).find(Boolean);
  return {repo: first ?? outcomes.map((o) => o.git_repository?.git_info?.repo).find(Boolean) ?? null, branch: null};
}

/** Whether Jack typed this message, and when it was recorded. */
export function readEvent(e: RecordedEvent): {at: number; prompt: boolean} | null {
  const at = Date.parse(e.created_at ?? "");
  if (!Number.isFinite(at) || !e.user) return null;
  const body = (e.user["internal_anthropic_catchall"] ?? e.user) as Record<string, unknown>;
  if (body["isSynthetic"] === true) return {at, prompt: false};
  const content = (body["message"] as {content?: unknown} | undefined)?.content;
  const hasText = typeof content === "string" ?
    content.trim().length > 0 :
    Array.isArray(content) && content.some((c) => (c as {type?: string})?.type === "text");
  return {at, prompt: typeof body["client_platform"] === "string" && hasText};
}

/** The sessions that count: run in the cloud, and not tagged to be left out. */
export function countedSessions(sessions: ListedSession[]): ListedSession[] {
  return sessions.filter((s) => s.environment_kind === "anthropic_cloud" && !(s.tags ?? []).includes(SKIP_TAG));
}

/**
 * One file per Eastern Time day in `days`, from the session list and each
 * session's recorded events. A day with no counted session still gets a file,
 * so the Mac can tell "no phone work" from "not exported yet".
 */
export function exportCloudDays(
  sessions: ListedSession[],
  eventsBySession: Map<string, RecordedEvent[]>,
  days: string[]
): CloudDayFile[] {
  const files = new Map(days.map((day) => [day, {day, sessions: [] as CloudSessionDay[]}]));
  for (const s of countedSessions(sessions)) {
    const seen = new Set<string>();
    const events = (eventsBySession.get(s.id) ?? [])
      .map(readEvent)
      .filter((e): e is {at: number; prompt: boolean} => e !== null)
      .sort((a, b) => a.at - b.at);
    const {repo, branch} = sessionRepo(s);
    const byDay = new Map<string, CloudSessionDay>();
    for (const e of events) {
      const day = etDateKey(new Date(e.at));
      const key = `${e.at}:${e.prompt}`;
      if (!files.has(day) || seen.has(key)) continue;
      seen.add(key);
      if (!byDay.has(day)) byDay.set(day, {id: s.id, title: s.title ?? "", origin: s.origin ?? "", repo, branch, events: []});
      byDay.get(day)!.events.push([new Date(e.at).toISOString(), e.prompt ? 1 : 0]);
    }
    for (const [day, entry] of byDay) {
      if (entry.events.some(([, p]) => p === 1)) files.get(day)!.sessions.push(entry);
    }
  }
  return [...files.values()];
}

const ORIGINS: Record<string, string> = {ios: "phone", android: "phone", web: "the web"};

/** Journal items from one day's file: one per stretch of a session's work that has a message from Jack. */
export function cloudItems(file: CloudDayFile, since: Date): {items: JournalItemInput[]; skipped: number} {
  const items: JournalItemInput[] = [];
  let skipped = 0;
  for (const s of file.sessions) {
    const events = s.events.map(([at, p]) => ({at: Date.parse(at), prompt: p === 1})).filter((e) => Number.isFinite(e.at));
    const stretches: Array<typeof events> = [];
    for (const e of events) {
      const current = stretches[stretches.length - 1];
      const last = current?.[current.length - 1];
      if (last && e.at - last.at <= GAP_MINUTES * 60_000) current.push(e);
      else stretches.push([e]);
    }
    const where = s.repo?.split("/")[1] ?? "the cloud";
    for (const stretch of stretches) {
      const first = stretch[0];
      const last = stretch[stretch.length - 1];
      const prompts = stretch.filter((e) => e.prompt).length;
      if (!prompts) {
        skipped++;
        continue;
      }
      if (last.at < since.getTime()) continue;
      items.push({
        source: "claude",
        sourceId: `cloud:${s.id}:${new Date(first.at).toISOString()}`,
        at: new Date(first.at).toISOString(),
        endAt: new Date(last.at).toISOString(),
        action: `Claude Code on ${ORIGINS[s.origin] ?? "the cloud"} in ${where}`,
        subject: s.title || where,
        detail: [s.branch, `${prompts} prompt${prompts === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        url: s.id.startsWith("session_") ? `https://claude.ai/code/${s.id}` : null,
        repo: s.repo,
        ticket: ticketInBranch(s.branch) ?? ticketInBranch(s.title),
      });
    }
  }
  return {items, skipped};
}

/** Every Eastern Time day from the one `since` falls in to the one `now` falls in. */
export function daysBetween(since: Date, now: Date): string[] {
  const days: string[] = [];
  for (let t = since.getTime(); ; t += 86_400_000) {
    const day = etDateKey(new Date(t));
    if (!days.includes(day)) days.push(day);
    if (day >= etDateKey(now)) break;
  }
  return days;
}

export interface CloudSessions {
  items: JournalItemInput[];
  /** Days whose file is not there yet: the nightly task has not run for them. */
  missingDays: string[];
  skipped: number;
}

/** Cloud Claude Code work that went on at or after `since`, from the exported files. */
export function readCloudSessions(since: Date, now: Date, api: GhApi = githubApi()): CloudSessions {
  const result: CloudSessions = {items: [], missingDays: [], skipped: 0};
  for (const day of daysBetween(since, now)) {
    let file: CloudDayFile;
    try {
      const answer = api(`repos/${CLOUD_DATA_REPO}/contents/${CLOUD_DATA_DIR}/${day}.json?ref=${CLOUD_DATA_BRANCH}`) as {content?: string};
      file = JSON.parse(Buffer.from(answer.content ?? "", "base64").toString("utf-8")) as CloudDayFile;
    } catch (err) {
      if (/HTTP 404/.test(String((err as Error).message))) {
        result.missingDays.push(day);
        continue;
      }
      throw err;
    }
    const {items, skipped} = cloudItems(file, since);
    result.items.push(...items);
    result.skipped += skipped;
  }
  return result;
}
