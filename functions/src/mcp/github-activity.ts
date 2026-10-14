/**
 * Read Jack's recent GitHub activity for the work journal, through the gh CLI
 * signed in as him, so the private repos of IHRDC and his own orgs are included.
 *
 * GitHub's events feed says what happened and when, but no longer carries pull
 * request titles or commit messages, so each is looked up once per run. The
 * feed keeps 90 days and at most 300 events.
 *
 * Kept: pull requests opened, merged, closed and reopened; reviews and review
 * comments; comments on issues and pull requests; issues opened and closed;
 * pushes; branches and repos created; releases. Left out: branch deletions,
 * which follow a merge, and stars, forks and the like.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {JournalItemInput, ticketInBranch} from "../tools/journal";

export class GitHubActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubActivityError";
  }
}

/** Calls the GitHub REST API with a path such as "repos/IHRDC/cmsonline/pulls/674". */
export type GhApi = (path: string) => unknown;

/** The API through gh, or the file named by MAISIE_GITHUB_FIXTURE (tests). */
export function githubApi(): GhApi {
  const fixture = process.env.MAISIE_GITHUB_FIXTURE;
  if (fixture) {
    // Keys are API paths; a path is also found without its query string.
    const answers = JSON.parse(readFileSync(fixture, "utf-8")) as Record<string, unknown>;
    return (path) => {
      const answer = answers[path] ?? answers[path.split("?")[0]];
      if (answer === undefined) throw new GitHubActivityError(`gh api ${path} failed: HTTP 404`);
      return answer;
    };
  }
  return (path) => {
    let raw: string;
    try {
      raw = execFileSync("gh", ["api", path], {encoding: "utf-8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024});
    } catch (err) {
      const e = err as {code?: string; stderr?: string; message?: string};
      if (e.code === "ENOENT") throw new GitHubActivityError("The gh command is not installed. Install it with `brew install gh`.");
      const why = (e.stderr || e.message || String(err)).trim();
      if (/auth login|not logged/i.test(why)) {
        throw new GitHubActivityError("gh is not signed in. Run `gh auth login` in a terminal.");
      }
      throw new GitHubActivityError(`gh api ${path} failed: ${why.slice(0, 300)}`);
    }
    return JSON.parse(raw);
  };
}

interface GhEvent {
  id: string;
  type: string;
  created_at: string;
  repo: {name: string};
  payload: Record<string, any>;
}

interface PullInfo {
  title: string;
  url: string | null;
  branch: string | null;
}

export interface GitHubActivity {
  login: string;
  items: JournalItemInput[];
  /** Events read but not journalled, such as branch deletions. */
  skipped: number;
  /** Titles or commit messages that could not be looked up. */
  lookupFailures: number;
}

const PAGES = 3;
const PER_PAGE = 100;

const firstLine = (s: unknown): string => (typeof s === "string" ? s.split("\n")[0].trim() : "");
const branchOf = (ref: unknown): string => (typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "");
const numberFromUrl = (url: unknown): number | null => {
  const m = typeof url === "string" ? url.match(/\/(?:pulls|issues)\/(\d+)$/) : null;
  return m ? Number(m[1]) : null;
};

/** Jack's GitHub activity since `since`, newest last. */
export function readGitHubActivity(since: Date, api: GhApi = githubApi()): GitHubActivity {
  const user = api("user") as {login?: string};
  if (!user?.login) throw new GitHubActivityError("gh did not say who is signed in.");
  const login = user.login;

  const events: GhEvent[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const batch = api(`users/${login}/events?per_page=${PER_PAGE}&page=${page}`) as GhEvent[];
    if (!Array.isArray(batch)) throw new GitHubActivityError("GitHub returned something other than a list of events.");
    events.push(...batch);
    // The feed is newest first, but not strictly; a whole page older than the start ends it.
    if (batch.length < PER_PAGE || batch.every((e) => Date.parse(e.created_at) < since.getTime())) break;
  }

  let lookupFailures = 0;
  const pulls = new Map<string, PullInfo | null>();
  const pull = (repo: string, n: number | null): PullInfo | null => {
    if (n == null) return null;
    const key = `${repo}#${n}`;
    if (!pulls.has(key)) {
      try {
        const p = api(`repos/${repo}/pulls/${n}`) as {title?: string; html_url?: string; head?: {ref?: string}};
        pulls.set(key, {title: p.title ?? "", url: p.html_url ?? null, branch: p.head?.ref ?? null});
      } catch {
        lookupFailures++;
        pulls.set(key, null);
      }
    }
    return pulls.get(key) ?? null;
  };
  const issueTitle = (repo: string, n: number): string => {
    try {
      return (api(`repos/${repo}/issues/${n}`) as {title?: string}).title ?? "";
    } catch {
      lookupFailures++;
      return "";
    }
  };

  const items: JournalItemInput[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id) || Date.parse(e.created_at) < since.getTime()) continue;
    seen.add(e.id);
    const repo = e.repo.name;
    const p = e.payload ?? {};
    const base = {source: "github" as const, sourceId: e.id, at: e.created_at, repo};

    switch (e.type) {
    case "PullRequestEvent": {
      const n: number | null = p["number"] ?? p["pull_request"]?.["number"] ?? null;
      const merged = p["action"] === "merged" || (p["action"] === "closed" && p["pull_request"]?.["merged"] === true);
      const verb = merged ? "Merged" :
        ({opened: "Opened", closed: "Closed", reopened: "Reopened"} as Record<string, string>)[p["action"]];
      if (!verb) {
        skipped++;
        break;
      }
      const info = pull(repo, n);
      const branch = info?.branch ?? p["pull_request"]?.["head"]?.["ref"] ?? null;
      items.push({
        ...base, action: `${verb} PR #${n}`, subject: info?.title || p["pull_request"]?.["title"] || `Pull request #${n}`,
        url: info?.url ?? `https://github.com/${repo}/pull/${n}`, detail: branch, ticket: ticketInBranch(branch),
      });
      break;
    }
    case "PullRequestReviewEvent":
    case "PullRequestReviewCommentEvent": {
      const n: number | null = p["pull_request"]?.["number"] ??
        numberFromUrl(p["review"]?.["pull_request_url"] ?? p["comment"]?.["pull_request_url"]);
      const info = pull(repo, n);
      const state = String(p["review"]?.["state"] ?? "").toLowerCase();
      const action = e.type === "PullRequestReviewCommentEvent" ? `Commented on PR #${n}` :
        state === "approved" ? `Approved PR #${n}` :
          state === "changes_requested" ? `Requested changes on PR #${n}` : `Reviewed PR #${n}`;
      items.push({
        ...base, action, subject: info?.title || `Pull request #${n}`,
        url: p["review"]?.["html_url"] ?? p["comment"]?.["html_url"] ?? info?.url ?? null,
        detail: e.type === "PullRequestReviewCommentEvent" ? p["comment"]?.["path"] ?? null : null,
        ticket: ticketInBranch(info?.branch),
      });
      break;
    }
    case "IssueCommentEvent": {
      const issue = p["issue"] ?? {};
      const n: number | null = issue["number"] ?? numberFromUrl(p["comment"]?.["issue_url"]);
      if (n == null) {
        skipped++;
        break;
      }
      const isPull = !!issue["pull_request"];
      const info = isPull ? pull(repo, n) : null;
      items.push({
        ...base, action: `Commented on ${isPull ? "PR" : "issue"} #${n}`,
        subject: issue["title"] || info?.title || issueTitle(repo, n) || `#${n}`,
        url: p["comment"]?.["html_url"] ?? null, ticket: ticketInBranch(info?.branch),
      });
      break;
    }
    case "IssuesEvent": {
      const verb = ({opened: "Opened", closed: "Closed", reopened: "Reopened"} as Record<string, string>)[p["action"]];
      const n: number | null = p["issue"]?.["number"] ?? null;
      if (!verb || n == null) {
        skipped++;
        break;
      }
      items.push({
        ...base, action: `${verb} issue #${n}`, subject: p["issue"]?.["title"] || issueTitle(repo, n) || `Issue #${n}`,
        url: p["issue"]?.["html_url"] ?? `https://github.com/${repo}/issues/${n}`,
      });
      break;
    }
    case "PushEvent": {
      const branch = branchOf(p["ref"]);
      const head = String(p["head"] ?? "");
      const before = String(p["before"] ?? "");
      let messages: string[] = [];
      let count = 0;
      let url = head ? `https://github.com/${repo}/commit/${head}` : null;
      try {
        if (/^0+$/.test(before) || !before) {
          messages = [firstLine((api(`repos/${repo}/commits/${head}`) as {commit?: {message?: string}}).commit?.message)];
          count = 1;
        } else {
          const cmp = api(`repos/${repo}/compare/${before}...${head}`) as {
            html_url?: string; commits?: Array<{commit?: {message?: string}}>; total_commits?: number;
          };
          messages = (cmp.commits ?? []).map((c) => firstLine(c.commit?.message));
          count = cmp.total_commits ?? messages.length;
          if (count > 1 && cmp.html_url) url = cmp.html_url;
        }
      } catch {
        // A force push leaves nothing to compare; the push still counts.
        lookupFailures++;
      }
      const latest = [...messages].reverse().find((m) => m) ?? "";
      items.push({
        ...base, action: `Pushed to ${branch || "a branch"}`, subject: latest || `Push to ${repo}`,
        detail: count ? `${count} commit${count === 1 ? "" : "s"}` : null, url, ticket: ticketInBranch(branch),
      });
      break;
    }
    case "CreateEvent": {
      const kind = p["ref_type"];
      if (kind === "repository") {
        items.push({...base, action: "Created repository", subject: repo, url: `https://github.com/${repo}`});
      } else if (kind === "branch" || kind === "tag") {
        items.push({
          ...base, action: `Created ${kind} ${p["ref"]}`, subject: repo,
          url: `https://github.com/${repo}/tree/${encodeURIComponent(String(p["ref"]))}`,
          ticket: kind === "branch" ? ticketInBranch(p["ref"]) : null,
        });
      } else {
        skipped++;
      }
      break;
    }
    case "ReleaseEvent": {
      const r = p["release"] ?? {};
      items.push({...base, action: `Published release ${r["tag_name"] ?? ""}`.trim(), subject: r["name"] || repo, url: r["html_url"] ?? null});
      break;
    }
    default:
      skipped++;
    }
  }
  return {login, items: items.reverse(), skipped, lookupFailures};
}
