/**
 * Read what Jack did in IHRDC's Jira for the work journal: issues he created,
 * changes he made (a status, an assignee, an edited field) and comments he
 * wrote, each with its own time.
 *
 * It signs in with Jack's email and an Atlassian API token kept in the macOS
 * Keychain under the service name maisie-jira. To add it once:
 *
 *   1. Create a token at https://id.atlassian.com/manage-profile/security/api-tokens
 *   2. security add-generic-password -s maisie-jira -a jnotarangelo@ihrdc.com -w
 *      (it asks for the token, so the token never appears in shell history)
 *
 * Jira's updatedBy() search finds the issues he changed since the start time;
 * each issue's change history and comments then give the times.
 */

import {execFileSync} from "child_process";
import {readFileSync} from "fs";
import {JournalItemInput} from "../tools/journal";

export const JIRA_SITE = "ihrdcdev.atlassian.net";
const KEYCHAIN_SERVICE = "maisie-jira";

export class JiraActivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraActivityError";
  }
}

/** GET a Jira REST path such as "/rest/api/3/myself". */
export type JiraApi = (path: string) => Promise<unknown>;

function keychainLogin(): {email: string; token: string} {
  const missing = new JiraActivityError(
    "No Jira API token in the Keychain. Create one at " +
    "https://id.atlassian.com/manage-profile/security/api-tokens, then run " +
    `\`security add-generic-password -s ${KEYCHAIN_SERVICE} -a <your Jira email> -w\` and paste it.`);
  try {
    const quiet = {encoding: "utf-8" as const, stdio: ["ignore", "pipe", "ignore"] as Array<"ignore" | "pipe">};
    const token = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], quiet).trim();
    const attributes = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], quiet);
    const email = attributes.match(/"acct"<blob>="([^"]+)"/)?.[1] ?? "";
    if (!token || !email) throw missing;
    return {email, token};
  } catch {
    throw missing;
  }
}

/** The Jira API with the Keychain token, or the file named by MAISIE_JIRA_FIXTURE (tests). */
export function jiraApi(): JiraApi {
  const fixture = process.env.MAISIE_JIRA_FIXTURE;
  if (fixture) {
    // Keys are API paths; a path is also found without its query string.
    const answers = JSON.parse(readFileSync(fixture, "utf-8")) as Record<string, unknown>;
    return async (path) => {
      const answer = answers[path] ?? answers[path.split("?")[0]];
      if (answer === undefined) throw new JiraActivityError(`Jira answered 404 for ${path.split("?")[0]}`);
      return answer;
    };
  }
  const {email, token} = keychainLogin();
  const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  return async (path) => {
    const response = await fetch(`https://${JIRA_SITE}${path}`, {headers: {Authorization: auth, Accept: "application/json"}});
    if (response.status === 401 || response.status === 403) {
      throw new JiraActivityError(`Jira refused the token in the Keychain (HTTP ${response.status}). It may have expired; create a new one.`);
    }
    if (!response.ok) {
      throw new JiraActivityError(`Jira answered ${response.status} for ${path.split("?")[0]}: ${(await response.text()).slice(0, 300)}`);
    }
    return response.json();
  };
}

interface JiraUser {
  accountId?: string;
  displayName?: string;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    created?: string;
    creator?: JiraUser;
    issuetype?: {name?: string};
  };
}

interface JiraHistory {
  id: string;
  created: string;
  author?: JiraUser;
  items?: Array<{field?: string; fromString?: string | null; toString?: string | null}>;
}

interface JiraComment {
  id: string;
  created: string;
  author?: JiraUser;
}

export interface JiraActivity {
  issues: number;
  items: JournalItemInput[];
}

const PAGE = 100;
const PARALLEL = 4;

/** What one change in an issue's history says Jack did. */
export function describeChange(key: string, history: JiraHistory, me: JiraUser): {action: string; detail: string | null} {
  const items = history.items ?? [];
  const status = items.find((i) => i.field === "status");
  if (status) {
    return {action: `Moved ${key} to ${status.toString ?? "a new status"}`, detail: `${status.fromString ?? "?"} → ${status.toString ?? "?"}`};
  }
  const assignee = items.find((i) => i.field === "assignee");
  if (assignee && items.length === 1) {
    if (assignee.toString && assignee.toString === me.displayName) return {action: `Took ${key}`, detail: null};
    return {action: assignee.toString ? `Assigned ${key} to ${assignee.toString}` : `Unassigned ${key}`, detail: null};
  }
  const fields = [...new Set(items.map((i) => i.field).filter((f): f is string => !!f))];
  return {action: `Edited ${key}`, detail: fields.join(", ") || null};
}

async function inParallel<T>(list: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(PARALLEL, list.length)}, async () => {
    while (next < list.length) await work(list[next++]);
  }));
}

/** Jack's Jira activity since `since`. */
export async function readJiraActivity(since: Date, api: JiraApi = jiraApi(), now = new Date()): Promise<JiraActivity> {
  const me = await api("/rest/api/3/myself") as JiraUser;
  if (!me?.accountId) throw new JiraActivityError("Jira did not say who the token belongs to.");
  const mine = (u?: JiraUser) => u?.accountId === me.accountId;
  const after = (when: string) => Date.parse(when) >= since.getTime();

  // updatedBy() takes a relative start, which Jira reads in Jack's own time zone.
  const minutes = Math.ceil((now.getTime() - since.getTime()) / 60_000) + 1;
  const jql = `issuekey IN updatedBy("${me.accountId}", "-${minutes}m") ORDER BY updated DESC`;
  const issues: JiraIssue[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({jql, fields: "summary,created,creator,issuetype", maxResults: String(PAGE)});
    if (token) params.set("nextPageToken", token);
    const page = await api(`/rest/api/3/search/jql?${params}`) as {issues?: JiraIssue[]; nextPageToken?: string};
    issues.push(...(page.issues ?? []));
    token = page.nextPageToken;
  } while (token);

  const items: JournalItemInput[] = [];
  await inParallel(issues, async (issue) => {
    const key = issue.key;
    const base = {
      source: "jira" as const, site: JIRA_SITE, ticket: key,
      subject: issue.fields.summary ?? key, url: `https://${JIRA_SITE}/browse/${key}`,
    };
    if (issue.fields.created && mine(issue.fields.creator) && after(issue.fields.created)) {
      items.push({...base, sourceId: `${key}:created`, at: issue.fields.created,
        action: `Created ${issue.fields.issuetype?.name ?? "issue"} ${key}`});
    }

    // Change history, oldest first, a page at a time.
    for (let startAt = 0; ; startAt += PAGE) {
      const page = await api(`/rest/api/3/issue/${key}/changelog?startAt=${startAt}&maxResults=${PAGE}`) as
        {values?: JiraHistory[]; isLast?: boolean; total?: number};
      for (const h of page.values ?? []) {
        if (!mine(h.author) || !after(h.created)) continue;
        items.push({...base, sourceId: `${key}:history:${h.id}`, at: h.created, ...describeChange(key, h, me)});
      }
      const values = page.values ?? [];
      if (page.isLast !== false || values.length === 0) break;
    }

    // The newest 100 comments are plenty for one run.
    const comments = await api(`/rest/api/3/issue/${key}/comment?orderBy=-created&maxResults=${PAGE}`) as {comments?: JiraComment[]};
    for (const c of comments.comments ?? []) {
      if (!mine(c.author) || !after(c.created)) continue;
      items.push({...base, sourceId: `${key}:comment:${c.id}`, at: c.created, action: `Commented on ${key}`,
        url: `https://${JIRA_SITE}/browse/${key}?focusedCommentId=${c.id}`});
    }
  });
  return {issues: issues.length, items};
}
