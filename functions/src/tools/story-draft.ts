/**
 * code_with_github: MAISIE drafts a story and one subtask for the NTA story agent.
 *
 * The story agent (Notarangelo-Technical-Advisory/nta-story-agent) works on a subtask
 * only when it is a sub-issue of a story, was opened by Jack, has every brief heading,
 * and Jack has added the `story-ready` label. MAISIE's token is Jack's, so the issues
 * are his. MAISIE never adds the label: Jack reads the draft and starts the work.
 */

const REPO = "Notarangelo-Technical-Advisory/jax-assistant";
const API = "https://api.github.com";

/** What MAISIE fills in. Every field is required. */
export interface StoryDraftInput {
  story_title: string;
  story_summary: string;
  subtask_title: string;
  goal: string;
  files: string[];
  interfaces: string;
  conventions: string;
  acceptance_criteria: string[];
  out_of_scope: string;
  test_expectations: string;
}

export type StoryDraftResult = {
  success: boolean;
  error?: string;
  story_url?: string;
  subtask_url?: string;
  message?: string;
};

const TEXT_FIELDS = [
  "story_title", "story_summary", "subtask_title", "goal", "interfaces", "conventions", "out_of_scope",
  "test_expectations",
] as const;
const LIST_FIELDS = ["files", "acceptance_criteria"] as const;

/** The fields that are missing or empty. */
export function missingFields(input: Partial<StoryDraftInput>): string[] {
  const missing: string[] = TEXT_FIELDS.filter((f) => typeof input[f] !== "string" || !input[f]?.trim());
  for (const f of LIST_FIELDS) {
    const list = input[f];
    if (!Array.isArray(list) || !list.some((item) => typeof item === "string" && item.trim())) missing.push(f);
  }
  return missing;
}

const bullets = (items: string[]): string =>
  items.filter((i) => i.trim()).map((i) => `- ${i.trim()}`).join("\n");

const FOOTER = "_Drafted by MAISIE. The story agent starts only when Jack adds the `story-ready` label to the subtask._";

/** The subtask's body: the story agent's brief, with its seven headings. */
export function briefBody(input: StoryDraftInput): string {
  return [
    "## Goal", input.goal.trim(),
    "## Files to change / create", bullets(input.files),
    "## Interfaces / contracts", input.interfaces.trim(),
    "## Conventions to apply", input.conventions.trim(),
    "## Acceptance criteria", bullets(input.acceptance_criteria),
    "## Out of scope", input.out_of_scope.trim(),
    "## Test expectations", input.test_expectations.trim(),
    "---", FOOTER,
  ].join("\n\n");
}

export function storyBody(input: StoryDraftInput): string {
  return `${input.story_summary.trim()}\n\n---\n\n${FOOTER}`;
}

type Fetch = typeof fetch;

/** Open the story, open the subtask, and make the subtask a sub-issue of the story. */
export async function draftStory(
  input: Partial<StoryDraftInput>, token: string | undefined, fetchImpl: Fetch = fetch,
): Promise<StoryDraftResult> {
  if (!token) {
    return {success: false, error: "MAISIE_PAT is not configured in the Cloud Functions environment."};
  }
  const missing = missingFields(input);
  if (missing.length) {
    return {success: false, error: `Fill in every part of the brief first. Missing: ${missing.join(", ")}.`};
  }
  const draft = input as StoryDraftInput;
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${API}/repos/${REPO}${path}`, {method: "POST", headers, body: JSON.stringify(body)});
    if (!response.ok) throw new Error(`GitHub API error ${response.status} on ${path}: ${await response.text()}`);
    return await response.json() as Record<string, unknown>;
  };

  let story: Record<string, unknown> | undefined;
  let subtask: Record<string, unknown> | undefined;
  try {
    story = await post("/issues", {title: `Story: ${draft.story_title.trim()}`.slice(0, 120), body: storyBody(draft)});
    subtask = await post("/issues", {title: draft.subtask_title.trim().slice(0, 120), body: briefBody(draft)});
    await post(`/issues/${story["number"]}/sub_issues`, {sub_issue_id: subtask["id"]});
  } catch (err) {
    const opened = [story?.["html_url"], subtask?.["html_url"]].filter(Boolean).join(" and ");
    return {
      success: false,
      error: `${(err as Error).message}${opened ? ` Already opened: ${opened}. Link or close them by hand.` : ""}`,
    };
  }
  return {
    success: true,
    story_url: String(story["html_url"]),
    subtask_url: String(subtask["html_url"]),
    message: "Draft story and subtask opened. Jack reads the subtask and adds the story-ready label to start " +
      "the story agent; it then opens a pull request for him to review.",
  };
}
