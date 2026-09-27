import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import twilio from "twilio";
import {MODEL} from "./model";

// ─── LinkedIn: the weekly Tuesday post ──────────────────────────
//
// The queue, the drafts and the writing rules live in the
// fractional-tech-advisory repository, not here:
//   operations/marketing/linkedin-queue.md       one row per Tuesday, with a Status
//   operations/marketing/linkedin-posts/          one draft per post, named by date
//   operations/skills/marketing-linkedin/SKILL.md the writing rules
//
// MAISIE reads and writes them through the GitHub contents API, so the
// repository stays the one source of truth and Jack can still edit the files
// by hand. Firestore holds only `linkedin/week`, a snapshot of the coming
// Tuesday for the dashboard card.
//
// The rules Jack set for this workflow, and where each is enforced:
//   - Nothing is posted unless Jack approved it       → approvePost / markPosted
//   - The words of an approved post never change      → writeDraft resets to drafted
//   - A post with a [PLACEHOLDER] cannot be approved  → approvePost
//   - Nothing is invented                             → the skill, in the draft prompt
//   - Fewer than 4 unposted topics → tell Jack        → lowQueue on the card
// Jack posts to LinkedIn himself; MAISIE never publishes.

const OWNER = "Notarangelo-Technical-Advisory";
const REPO = "fractional-tech-advisory";
const BRANCH = "main";
const QUEUE_PATH = "operations/marketing/linkedin-queue.md";
const POSTS_DIR = "operations/marketing/linkedin-posts";
const SKILL_PATH = "operations/skills/marketing-linkedin/SKILL.md";
const LOW_QUEUE = 4;
const ET = "America/New_York";

export type PostStatus = "idea" | "drafted" | "approved" | "posted";
const STATUSES: PostStatus[] = ["idea", "drafted", "approved", "posted"];

export interface QueueRow {
  /** YYYY-MM-DD */
  date: string;
  /** The date cell as written, e.g. "2026-09-29 Tue". */
  dateCell: string;
  title: string;
  theme: string;
  practice: string;
  format: string;
  firstLine: string;
  offer: string;
  status: PostStatus;
}

export interface Draft {
  path: string;
  post: string;
  firstComment: string;
  image: string;
  /** Any other section, such as a poll's question and options, in file order. */
  extras: Array<{heading: string; text: string}>;
  placeholders: string[];
}

/** What the dashboard card shows for the coming Tuesday. */
export interface LinkedInWeek {
  tuesday: string;
  title: string | null;
  status: PostStatus | null;
  /**
   * no-row          the queue has no row for this Tuesday
   * not-drafted     the row is still an idea
   * needs-approval  a draft is waiting for Jack
   * approved        approved, Tuesday not yet here
   * post-today      approved, and today is Tuesday
   * missing-today   today is Tuesday and nothing is approved: post nothing
   * posted          done
   */
  stage: string;
  draft: Draft | null;
  draftUrl: string | null;
  remaining: number;
  lowQueue: boolean;
  postUrl: string | null;
}

// ─── Eastern Time dates ────────────────────────────────────────

function etParts(d: Date): {key: string; weekday: string} {
  const key = d.toLocaleDateString("en-CA", {timeZone: ET});
  const weekday = d.toLocaleDateString("en-US", {timeZone: ET, weekday: "short"});
  return {key, weekday};
}

function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Today if it is Tuesday in Norwell, otherwise the next Tuesday. */
export function comingTuesday(now: Date): string {
  const {key, weekday} = etParts(now);
  const offset = (2 - WEEKDAYS.indexOf(weekday) + 7) % 7;
  return addDays(key, offset);
}

// ─── GitHub contents API ───────────────────────────────────────

function token(): string {
  const t = process.env.LINKEDIN_QUEUE_PAT;
  if (!t) {
    throw new Error("LINKEDIN_QUEUE_PAT is not set. Add a GitHub token with Contents read and write on fractional-tech-advisory as that repository secret.");
  }
  return t;
}

async function gh<T>(path: string, init?: {method: string; body: unknown}): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${token()}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init ? {"Content-Type": "application/json"} : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path.split("?")[0]} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

interface RepoFile {content: string; sha: string}

async function readFile(path: string): Promise<RepoFile> {
  const f = await gh<{content: string; sha: string}>(`contents/${path}?ref=${BRANCH}`);
  return {content: Buffer.from(f.content, "base64").toString("utf8"), sha: f.sha};
}

/**
 * Write a file. `sha` is the version that was read; GitHub refuses the write
 * with 409 if the file changed since, so an edit Jack made by hand is never
 * overwritten silently.
 */
async function writeFile(path: string, content: string, sha: string | null, message: string): Promise<void> {
  await gh(`contents/${path}`, {
    method: "PUT",
    body: {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: BRANCH,
      ...(sha ? {sha} : {}),
    },
  });
}

async function findDraftPath(date: string): Promise<string | null> {
  const files = await gh<Array<{name: string; path: string}>>(`contents/${POSTS_DIR}?ref=${BRANCH}`);
  return files.find((f) => f.name.startsWith(date) && f.name.endsWith(".md"))?.path ?? null;
}

function blobUrl(path: string): string {
  return `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${path}`;
}

// ─── Parsing ───────────────────────────────────────────────────

export function parseQueue(md: string): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const line of md.split("\n")) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 8) continue;
    const status = cells[7].toLowerCase() as PostStatus;
    if (!STATUSES.includes(status)) continue;
    rows.push({
      date: cells[0].slice(0, 10),
      dateCell: cells[0],
      title: cells[1],
      theme: cells[2],
      practice: cells[3],
      format: cells[4],
      firstLine: cells[5],
      offer: cells[6],
      status,
    });
  }
  return rows;
}

/** Change the Status cell of one row, leaving every other character alone. */
export function setQueueStatus(md: string, date: string, status: PostStatus): string {
  let found = false;
  const out = md.split("\n").map((line) => {
    if (!line.startsWith(`| ${date}`)) return line;
    found = true;
    return line.replace(/\|\s*(idea|drafted|approved|posted)\s*\|\s*$/i, `| ${status} |`);
  }).join("\n");
  if (!found) throw new Error(`The queue has no row for ${date}.`);
  return out;
}

/** Text between a "## Heading" line and the next heading. */
function section(md: string, heading: string): string {
  const m = md.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"));
  return m ? m[1].trim() : "";
}

const PLACEHOLDER = /\[[^\]\n]{2,}\]/g;

export function parseDraft(path: string, md: string): Draft {
  const postBlock = section(md, "Post");
  const fenced = postBlock.match(/```[^\n]*\n([\s\S]*?)\n```/);
  const post = (fenced ? fenced[1] : postBlock).trim();
  const firstComment = section(md, "First comment");
  const image = section(md, "Image");
  const known = ["Post", "First comment", "Image"];
  const extras = [...md.matchAll(/^## (.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((h) => !known.includes(h))
    .map((heading) => ({heading, text: section(md, escapeRegex(heading))}));
  const checked = [post, firstComment, ...extras.map((e) => e.text)].join("\n");
  const placeholders = [...checked.matchAll(PLACEHOLDER)].map((m) => m[0]);
  return {path, post, firstComment, image, extras, placeholders};
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setDraftStatus(md: string, status: PostStatus): string {
  return md.replace(/^(- \*\*Status:\*\*\s*)\S+/m, `$1${status}`);
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// ─── Reading the week ──────────────────────────────────────────

async function loadQueue(): Promise<{file: RepoFile; rows: QueueRow[]}> {
  const file = await readFile(QUEUE_PATH);
  return {file, rows: parseQueue(file.content)};
}

async function loadDraft(date: string): Promise<{file: RepoFile; draft: Draft} | null> {
  const path = await findDraftPath(date);
  if (!path) return null;
  const file = await readFile(path);
  return {file, draft: parseDraft(path, file.content)};
}

/**
 * Build the view of one Tuesday's post. `now` decides the stage, because
 * "post-today" and "missing-today" only make sense on that Tuesday.
 */
async function buildWeek(tuesday: string, now: Date, previousUrl: string | null): Promise<LinkedInWeek> {
  const {key: today} = etParts(now);
  const {rows} = await loadQueue();
  const row = rows.find((r) => r.date === tuesday) ?? null;
  const loaded = row && row.status !== "idea" ? await loadDraft(tuesday) : null;
  const isThatTuesday = today === tuesday;

  let stage: string;
  if (!row) stage = isThatTuesday ? "missing-today" : "no-row";
  else if (row.status === "posted") stage = "posted";
  else if (row.status === "approved") stage = isThatTuesday ? "post-today" : "approved";
  else if (isThatTuesday) stage = "missing-today";
  else stage = row.status === "idea" ? "not-drafted" : "needs-approval";

  const remaining = rows.filter((r) => r.date >= today && (r.status === "idea" || r.status === "drafted")).length;
  return {
    tuesday,
    title: row?.title ?? null,
    status: row?.status ?? null,
    stage,
    draft: loaded?.draft ?? null,
    draftUrl: loaded ? blobUrl(loaded.draft.path) : null,
    remaining,
    lowQueue: remaining < LOW_QUEUE,
    postUrl: previousUrl,
  };
}

/** Read the coming Tuesday from GitHub and save it as the dashboard card. */
export async function refreshWeek(db: admin.firestore.Firestore, now = new Date()): Promise<LinkedInWeek> {
  const tuesday = comingTuesday(now);
  const previous = (await db.collection("linkedin").doc("week").get()).data() as LinkedInWeek | undefined;
  const week = await buildWeek(tuesday, now, previous?.tuesday === tuesday ? previous.postUrl ?? null : null);
  await db.collection("linkedin").doc("week").set({
    ...week,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return week;
}

/**
 * After a change: update the card, and return the post that changed, which
 * need not be the coming Tuesday's (Jack can approve weeks ahead).
 */
async function afterChange(db: admin.firestore.Firestore, date: string, postUrl: string | null = null): Promise<LinkedInWeek> {
  const card = await refreshWeek(db);
  return card.tuesday === date ? card : buildWeek(date, new Date(), postUrl);
}

// ─── Changing a status ─────────────────────────────────────────

async function changeStatus(date: string, from: PostStatus[], to: PostStatus, extra?: (md: string) => string): Promise<void> {
  const {file, rows} = await loadQueue();
  const row = rows.find((r) => r.date === date);
  if (!row) throw new Error(`The queue has no row for ${date}.`);
  if (row.status === to) return;
  if (!from.includes(row.status)) {
    throw new Error(`The post for ${date} is "${row.status}"; it must be ${from.map((s) => `"${s}"`).join(" or ")} to become "${to}".`);
  }
  // The queue decides, so it is written first. If the draft file's copy of the
  // status then fails to update, the queue is still right and the next change
  // corrects the file.
  await writeFile(QUEUE_PATH, setQueueStatus(file.content, date, to), file.sha, `chore(linkedin): mark ${date} ${to} (via MAISIE)`);
  const loaded = await loadDraft(date);
  if (loaded) {
    const updated = (extra ?? ((s: string) => s))(setDraftStatus(loaded.file.content, to));
    if (updated !== loaded.file.content) {
      await writeFile(loaded.draft.path, updated, loaded.file.sha, `chore(linkedin): mark ${date} ${to} (via MAISIE)`)
        .catch((err) => console.warn(`[linkedin] queue updated, but the draft file's status line was not: ${err}`));
    }
  }
}

/** Jack's written approval. Refused while the draft still has a [PLACEHOLDER]. */
export async function approvePost(db: admin.firestore.Firestore, date: string): Promise<LinkedInWeek> {
  const loaded = await loadDraft(date);
  if (!loaded) throw new Error(`There is no draft for ${date} to approve.`);
  if (loaded.draft.placeholders.length > 0) {
    throw new Error(`The draft for ${date} still has placeholders to fill: ${loaded.draft.placeholders.join(", ")}.`);
  }
  await changeStatus(date, ["drafted"], "approved");
  return afterChange(db, date);
}

/** Jack says the post is live. Only an approved post can become posted. */
export async function markPosted(db: admin.firestore.Firestore, date: string, url?: string): Promise<LinkedInWeek> {
  const link = url?.trim();
  await changeStatus(date, ["approved"], "posted", link ?
    (md) => md.replace(/^(- \*\*Status:\*\*.*)$/m, `$1\n- **Link:** ${link}`) :
    undefined);
  if (link && comingTuesday(new Date()) === date) {
    await db.collection("linkedin").doc("week").set({postUrl: link}, {merge: true});
  }
  return afterChange(db, date, link ?? null);
}

// ─── Writing a draft ───────────────────────────────────────────

const SUBMIT_DRAFT: Anthropic.Messages.Tool = {
  name: "submit_draft",
  description: "Submit the finished draft. Call this once.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["post", "firstComment", "image", "poll"],
    properties: {
      poll: {type: "string", description: "For a poll only: the question and the 3 or 4 options, each option at most 30 characters, as \"Question: ...\" then one option per line. An empty string for every other format."},
      post: {type: "string", description: "The post exactly as it will be pasted into LinkedIn, plain text. For a carousel, the text of each slide; for a poll, the question, options and post text."},
      firstComment: {type: "string"},
      image: {type: "string", description: "A one-line image idea, or \"No image needed.\""},
    },
  },
};

/**
 * Write or rewrite the draft for one Tuesday with the marketing-linkedin skill.
 *
 * With `instructions`, the existing draft is revised as Jack asked. A revised
 * post goes back to "drafted", even if it was approved, because Jack approves
 * words, and these are new words.
 */
export async function writeDraft(
  db: admin.firestore.Firestore,
  date: string,
  instructions?: string
): Promise<LinkedInWeek> {
  const [{file: queueFile, rows}, skill, existing] = await Promise.all([
    loadQueue(), readFile(SKILL_PATH), loadDraft(date),
  ]);
  const row = rows.find((r) => r.date === date);
  if (!row) throw new Error(`The queue has no row for ${date}.`);
  if (row.status === "posted") throw new Error(`The post for ${date} is already live on LinkedIn.`);
  if (existing && !instructions) {
    throw new Error(`The post for ${date} already has a draft. Say what to change to revise it.`);
  }

  const ask = existing ?
    `Revise this draft as Jack asks. Keep his meaning, and change only what he asks for.\n\nJack's request: ${instructions}\n\nCurrent draft:\n${existing.file.content}` :
    `Write the post for this row of the queue. Use its first line as the post's first line, its format, its theme and its practice.${instructions ? `\n\nJack also asks: ${instructions}` : ""}\n\nRow:\n${JSON.stringify(row)}`;

  const anthropic = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: {type: "adaptive"},
    output_config: {effort: "high"},
    system: `${skill.content}\n\n---\n\nYou are drafting one post for Jack's Tuesday LinkedIn queue. Follow every rule in the skill above. Never invent a client, a number, a quote or a story: where the post needs a detail you do not have, leave a placeholder in square brackets such as [STORY: ...]. When the draft is finished and checked against "Check before you hand it over", call submit_draft.`,
    tools: [SUBMIT_DRAFT],
    messages: [{role: "user", content: ask}],
  });
  const submit = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_DRAFT.name
  );
  if (!submit) throw new Error(`The draft was not submitted (stop_reason: ${response.stop_reason}).`);
  const out = submit.input as {post: string; firstComment: string; image: string; poll: string};
  const poll = out.poll.trim() ? `## Poll\n\n${out.poll.trim()}\n\n` : "";

  const content = `# ${row.title}

- **Date:** ${row.dateCell}
- **Theme:** ${row.theme}
- **Practice:** ${row.practice}
- **Format:** ${row.format}
- **Status:** drafted

${poll}## Post

\`\`\`
${out.post.trim()}
\`\`\`

## First comment

${out.firstComment.trim()}

## Image

${out.image.trim()}
`;
  const path = existing?.draft.path ?? `${POSTS_DIR}/${date}-${slug(row.title)}.md`;
  const verb = existing ? "revise" : "draft";
  // Queue first: an approved post must stop being approved before its words
  // change, or a failure between the two writes would leave new words approved.
  if (row.status !== "drafted") {
    await writeFile(QUEUE_PATH, setQueueStatus(queueFile.content, date, "drafted"), queueFile.sha,
      `chore(linkedin): mark ${date} drafted (via MAISIE)`);
  }
  await writeFile(path, content, existing?.file.sha ?? null, `feat(linkedin): ${verb} the ${date} post (via MAISIE)`);
  return afterChange(db, date);
}

/** Thursday: draft next Tuesday's post if it is still an idea. */
export async function draftIfIdea(db: admin.firestore.Firestore, now = new Date()): Promise<LinkedInWeek> {
  const tuesday = comingTuesday(now);
  const {rows} = await loadQueue();
  const row = rows.find((r) => r.date === tuesday);
  if (row?.status === "idea") return writeDraft(db, tuesday);
  return refreshWeek(db, now);
}

// ─── Telling Jack ──────────────────────────────────────────────

/** One-line summary of the card, for a text message or a chat answer. */
export function describeWeek(w: LinkedInWeek): string {
  const day = new Date(`${w.tuesday}T12:00:00Z`).toLocaleDateString("en-US", {timeZone: "UTC", month: "short", day: "numeric"});
  const low = w.lowQueue ? ` Only ${w.remaining} unposted topics are left in the queue; ask me to plan more.` : "";
  const title = w.title ? `"${w.title}"` : "the post";
  switch (w.stage) {
  case "needs-approval":
    return w.draft?.placeholders.length ?
      `Your LinkedIn post for Tuesday ${day}, ${title}, is drafted but has placeholders to fill: ${w.draft.placeholders.join(", ")}.${low}` :
      `Your LinkedIn post for Tuesday ${day}, ${title}, is ready. Please approve it in MAISIE, or tell me what to change.${low}`;
  case "not-drafted": return `The LinkedIn post for Tuesday ${day}, ${title}, has no draft yet.${low}`;
  case "approved": return `Your LinkedIn post for Tuesday ${day}, ${title}, is approved and ready.${low}`;
  case "post-today": return `Today is LinkedIn day. Your approved post, ${title}, is in MAISIE ready to copy. Post it, add the first comment, then press "I posted it".${low}`;
  case "missing-today": return `No LinkedIn post is approved for today, so nothing should be published.${low}`;
  case "posted": return `The LinkedIn post for Tuesday ${day}, ${title}, is posted.${low}`;
  default: return `The LinkedIn queue has no row for Tuesday ${day}.${low}`;
  }
}

/** Best effort: a failed text is logged, not thrown, because the card still shows it. */
export async function textJack(body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const to = process.env.JACK_PHONE_NUMBER;
  if (!sid || !auth || !from || !to) {
    console.warn("[linkedin] Twilio is not configured; no text sent");
    return;
  }
  try {
    await twilio(sid, auth).messages.create({from, to, body});
  } catch (err) {
    console.error("[linkedin] text to Jack failed:", err);
  }
}
