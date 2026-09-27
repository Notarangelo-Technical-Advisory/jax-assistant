import Anthropic from "@anthropic-ai/sdk";

// ─── Headlines ──────────────────────────────────────────────────
//
// The Headlines tab on the dashboard. One model call with web search gathers
// what the people and companies Jack follows have said or done since the last
// run, and hands it back through `submit_headlines` as structured items.
//
// Structured output (output_config.format) is not used: web search results
// carry citations, and citations and output_config.format together are a 400.
// A strict tool gives the same schema guarantee without that conflict.

/**
 * Who and what Jack follows. Phase 1 keeps this in code; moving it to
 * Firestore so Jack can edit it from chat is Phase 3 in
 * projects/headlines/README.md.
 *
 * `where` names the places the person actually publishes. Most of them post
 * first on X, which web search reads poorly, so the podcasts and newsletters
 * are listed to give the model something it can reach.
 */
export const HEADLINE_PEOPLE = [
  {name: "Paweł Huryn", where: "The Product Compass newsletter (productcompass.pm), LinkedIn, X @PawelHuryn — AI for product managers"},
  {name: "David Sacks", where: "All-In podcast, X @DavidSacks — technology, AI policy, venture capital"},
  {name: "Chamath Palihapitiya", where: "All-In podcast, his Substack, X @chamath — markets, technology, venture capital"},
  {name: "Benny Johnson", where: "The Benny Show (podcast and YouTube), X @bennyjohnson — US politics"},
];

export const HEADLINE_AI_COMPANIES = [
  "Anthropic", "OpenAI", "Google DeepMind / Gemini", "Meta AI", "xAI",
  "Microsoft AI", "NVIDIA",
];

/** Section keys in display order. The dashboard renders them in this order. */
export const HEADLINE_SECTIONS = [
  {key: "people", title: "People You Follow"},
  {key: "ai", title: "AI Companies"},
  {key: "markets", title: "Markets"},
] as const;

type SectionKey = typeof HEADLINE_SECTIONS[number]["key"];

export interface HeadlineItem {
  section: SectionKey;
  headline: string;
  summary: string;
  whyItMatters: string;
  sourceName: string;
  url: string;
  publishedAt: string | null;
}

export interface HeadlinesResult {
  sections: Array<{key: SectionKey; title: string; items: HeadlineItem[]}>;
  /** Items the model returned whose URL never appeared in a search or fetch result. */
  unverified: HeadlineItem[];
}

const SUBMIT_TOOL: Anthropic.Messages.Tool = {
  name: "submit_headlines",
  description:
    "Submit the finished headlines. Call this exactly once, after your research is done. " +
    "Every item must use a URL that appeared in a web_search or web_fetch result in this conversation.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["section", "headline", "summary", "whyItMatters", "sourceName", "url", "publishedAt"],
          properties: {
            section: {type: "string", enum: HEADLINE_SECTIONS.map((s) => s.key)},
            headline: {type: "string", description: "One line, under 100 characters."},
            summary: {type: "string", description: "One or two plain sentences on what happened."},
            whyItMatters: {type: "string", description: "One sentence on why Jack in particular should care."},
            sourceName: {type: "string", description: "The publication or person, e.g. \"All-In podcast\" or \"Anthropic blog\"."},
            url: {type: "string"},
            publishedAt: {
              type: ["string", "null"],
              description: "YYYY-MM-DD if the source states a date, otherwise null.",
            },
          },
        },
      },
    },
  },
};

// Own copy of the web tools rather than WEB_TOOLS: this call needs more
// searches than a chat turn, and web_fetch citations would only add blocks
// this code throws away.
const HEADLINE_WEB_TOOLS: Anthropic.Messages.ToolUnion[] = [
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 15,
    user_location: {type: "approximate", country: "US", timezone: "America/New_York"},
  },
  {
    type: "web_fetch_20260209",
    name: "web_fetch",
    max_uses: 5,
    max_content_tokens: 20000,
  },
];

function buildSystemPrompt(todayLabel: string): string {
  const people = HEADLINE_PEOPLE.map((p) => `- ${p.name}: ${p.where}`).join("\n");
  return `You are Maisie, Jack Notarangelo's executive assistant, preparing the Headlines tab of his briefing. Today is ${todayLabel} (Eastern Time).

Jack is a technical advisor on AI adoption. Find what is new in the last 24-48 hours in three sections:

1. people — what these people have said, published or done:
${people}
2. ai — significant news from these AI companies: ${HEADLINE_AI_COMPANIES.join(", ")}. Model releases, major product launches, pricing changes, policy or legal news. Skip minor feature updates.
3. markets — only events that moved, or are expected to move, the S&P 500: a move of more than 1% in a day, a Federal Reserve decision, a CPI or jobs report, or earnings from one of the largest companies in the index. Do not state index levels or prices; those will come from a market data source later. If nothing significant happened, return no markets items.

Rules:
- Every item must link to a URL that appeared in your web_search or web_fetch results. Never write a URL from memory. Items with other URLs are discarded.
- Only include items from the last 48 hours. If a source has nothing new, leave it out rather than include older news.
- At most 4 items per section. Prefer fewer, more important items.
- Write in plain English. No markdown.
- Report what people said without adding your own opinion of it.
- When you are finished, call submit_headlines once with all the items.`;
}

/**
 * Every URL the server-side tools actually returned in this conversation.
 *
 * The `_20260209` web tools filter results with code execution before the
 * model reads them, so many results reach the model as code-execution output
 * rather than as `web_search_tool_result` blocks. Matching only those two block
 * types dropped nearly every item on the first run. Instead, scan every block
 * the model did not write itself for URLs.
 */
function collectSeenUrls(content: Anthropic.Messages.ContentBlock[], into: Set<string>): void {
  for (const block of content) {
    if (block.type === "text" || block.type === "thinking" || block.type === "tool_use" ||
        block.type === "server_tool_use" || block.type === "redacted_thinking") {
      continue;
    }
    for (const match of JSON.stringify(block).matchAll(URL_PATTERN)) {
      into.add(normalizeUrl(match[0]));
    }
  }
}

const URL_PATTERN = /https?:\/\/[^\s"'<>\\)\]]+/g;

/**
 * Compare URLs by host and path only. The model often drops tracking
 * parameters, "www." or the trailing slash when it copies a link, and none of
 * those make a different page.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, "");
    return host + path;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Run the research call and return the verified headlines.
 *
 * Throws on API failure or when the model never calls submit_headlines, so the
 * caller can keep the previous headlines instead of overwriting them with
 * nothing.
 */
export async function generateHeadlines(
  anthropic: Anthropic,
  model: string,
  todayLabel: string
): Promise<HeadlinesResult> {
  const messages: Anthropic.Messages.MessageParam[] = [
    {role: "user", content: "Prepare today's headlines."},
  ];
  const request = (): Anthropic.Messages.MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: 16000,
    thinking: {type: "adaptive"},
    output_config: {effort: "medium"},
    system: buildSystemPrompt(todayLabel),
    tools: [...HEADLINE_WEB_TOOLS, SUBMIT_TOOL],
    messages,
  });

  const seenUrls = new Set<string>();
  let response = await anthropic.messages.create(request());
  collectSeenUrls(response.content, seenUrls);

  // Server-side search runs inside one request but pauses after ~10 internal
  // iterations with "pause_turn"; resuming needs only the assistant content.
  const MAX_CONTINUATIONS = 4;
  for (let i = 0; response.stop_reason === "pause_turn" && i < MAX_CONTINUATIONS; i++) {
    messages.push({role: "assistant", content: response.content});
    response = await anthropic.messages.create(request());
    collectSeenUrls(response.content, seenUrls);
  }

  const submit = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_TOOL.name
  );
  if (!submit) {
    throw new Error(`submit_headlines was not called (stop_reason: ${response.stop_reason})`);
  }

  const items = ((submit.input as {items?: HeadlineItem[]}).items ?? []);
  const verified = items.filter((it) => seenUrls.has(normalizeUrl(it.url)));

  return {
    sections: HEADLINE_SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      items: verified.filter((it) => it.section === s.key),
    })),
    unverified: items.filter((it) => !seenUrls.has(normalizeUrl(it.url))),
  };
}
