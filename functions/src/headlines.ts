import Anthropic from "@anthropic-ai/sdk";
import {XMLParser} from "fast-xml-parser";
import type {MarketSnapshot} from "./markets";

// ─── Headlines ──────────────────────────────────────────────────
//
// The Headlines tab on the dashboard. Code gathers the candidate stories from
// news feeds; one model call, with no web tools, chooses the ones that matter
// and writes the summaries, handing them back through `submit_headlines`.
//
// Until 2026-09-29 the model found the stories itself with web search, which
// cost $2-5 a run and took up to nine minutes. Now every link comes from a
// feed: the model names a candidate by id and the code copies the link from
// that candidate, so the model cannot write a link that does not exist.

/** Section keys in display order. The dashboard renders them in this order. */
export const HEADLINE_SECTIONS = [
  {key: "people", title: "People You Follow"},
  {key: "ai", title: "AI Companies"},
  {key: "markets", title: "Markets"},
] as const;

type SectionKey = typeof HEADLINE_SECTIONS[number]["key"];

/**
 * Feeds read directly. Moving the list to Firestore so Jack can edit it from
 * chat is Phase 3 in projects/headlines/README.md.
 */
export const HEADLINE_FEEDS: Array<{section: SectionKey; name: string; url: string; limit?: number}> = [
  {section: "people", name: "The Product Compass (Paweł Huryn)", url: "https://www.productcompass.pm/feed"},
  {section: "people", name: "All-In podcast", url: "https://rss.libsyn.com/shows/254861/destinations/1928300.xml"},
  {section: "people", name: "Chamath Palihapitiya (Substack)", url: "https://chamath.substack.com/feed"},
  {section: "people", name: "The Benny Show", url: "https://feeds.megaphone.fm/BENNYMED7549931483"},
  {section: "ai", name: "OpenAI", url: "https://openai.com/news/rss.xml"},
  {section: "ai", name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml"},
  {section: "ai", name: "Google AI blog", url: "https://blog.google/technology/ai/rss/"},
  {section: "ai", name: "NVIDIA blog", url: "https://blogs.nvidia.com/feed/"},
  {section: "ai", name: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/"},
  {section: "ai", name: "The Verge", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"},
  // General business news: more items, because most are not about the market.
  {section: "markets", name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", limit: 10},
  {section: "markets", name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", limit: 10},
];

/**
 * Bing News searches. They cover what has no feed of its own (Anthropic;
 * Microsoft's blog refuses automated readers), press coverage of the
 * companies, and posts on X, which reach the dashboard only when the press
 * reports them. Google News was used first, but it answers every request from
 * Cloud Run with HTTP 503.
 */
export const HEADLINE_NEWS_QUERIES: Array<{section: SectionKey; query: string}> = [
  {section: "people", query: "\"David Sacks\""},
  {section: "people", query: "\"Chamath Palihapitiya\""},
  {section: "people", query: "\"Benny Johnson\""},
  {section: "people", query: "\"Paweł Huryn\" OR \"Pawel Huryn\""},
  {section: "ai", query: "Anthropic Claude"},
  {section: "ai", query: "OpenAI"},
  {section: "ai", query: "\"Google DeepMind\" OR \"Google Gemini\""},
  {section: "ai", query: "\"Meta AI\""},
  {section: "ai", query: "xAI Grok"},
  {section: "ai", query: "\"Microsoft AI\" OR \"Microsoft Copilot\""},
  {section: "ai", query: "NVIDIA AI"},
  {section: "markets", query: "\"stock market today\""},
  {section: "markets", query: "\"Federal Reserve\" OR \"CPI report\" OR \"jobs report\""},
];

/** Only stories from this many hours back are candidates. */
const WINDOW_HOURS = 48;
/** Feed items kept per feed, newest first. */
const ITEMS_PER_FEED = 5;
/** Bing News results kept per search, newest first. */
const ITEMS_PER_SEARCH = 8;
/** The dashboard shows at most this many items per section. */
const ITEMS_PER_SECTION = 4;
const FETCH_TIMEOUT_MS = 15_000;
const DESCRIPTION_CHARS = 400;
const USER_AGENT = "Mozilla/5.0 (compatible; MAISIE-headlines/2.0; +https://notarangelo.com)";

/** List price of MODEL per million tokens, for the cost recorded on each run. Update with MODEL. */
const PRICE_PER_MTOK = {input: 2, output: 10};

export interface HeadlineItem {
  section: SectionKey;
  headline: string;
  summary: string;
  whyItMatters: string;
  sourceName: string;
  url: string;
  publishedAt: string | null;
  /** A pre-market futures report taken from the news, not from live data. */
  futures: boolean;
}

export interface HeadlinesUsage {
  candidates: number;
  inputTokens: number;
  outputTokens: number;
  /** At the list price in PRICE_PER_MTOK. */
  estimatedCostUsd: number;
}

export interface HeadlinesResult {
  sections: Array<{key: SectionKey; title: string; items: HeadlineItem[]}>;
  usage: HeadlinesUsage;
  /** Feeds and searches that could not be read on this run, with the reason. */
  sourceErrors: string[];
}

interface Candidate {
  id: string;
  section: SectionKey;
  title: string;
  description: string;
  sourceName: string;
  url: string;
  published: Date;
  /** Came from the pre-market futures search; only these may be marked futures. */
  futures: boolean;
}

// ─── Gathering candidates ──────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  htmlEntities: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

/** The text of a parsed node, whether the parser gave a string, a number or an object with attributes. */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object") return textOf((node as Record<string, unknown>)["#text"]);
  return "";
}

function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

interface FeedEntry {
  title: string;
  url: string;
  published: Date;
  description: string;
  /** Bing News names the publisher of each result; ordinary feeds do not. */
  source: string | null;
  /** False when the entry had no link and `url` is the feed's own page. */
  ownLink: boolean;
}

/** RSS 2.0 or Atom. Entries without a title, link or valid date are skipped. */
function parseFeed(body: string): FeedEntry[] {
  const doc = xml.parse(body) as Record<string, any>;
  const rssItems: any[] = doc.rss?.channel?.item ?? [];
  // Some podcast feeds, such as The Benny Show's, give episodes no web link;
  // those link to the show's page instead.
  const channelLink = textOf(doc.rss?.channel?.link).trim();
  const atomEntries: any[] = doc.feed?.entry ?? [];

  const entries: FeedEntry[] = [];
  for (const it of rssItems) {
    const guid = it.guid?.["@_isPermaLink"] === "false" ? "" : textOf(it.guid).trim();
    const own = articleUrl(textOf(it.link).trim()) || (/^https?:\/\//.test(guid) ? guid : "");
    entries.push({
      title: plainText(textOf(it.title)),
      url: own || channelLink,
      ownLink: own !== "",
      published: new Date(textOf(it.pubDate) || textOf(it["dc:date"])),
      description: plainText(textOf(it.description) || textOf(it["itunes:summary"])),
      source: textOf(it["News:Source"]).trim() || null,
    });
  }
  for (const e of atomEntries) {
    const links: any[] = e.link ?? [];
    const link = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
    entries.push({
      title: plainText(textOf(e.title)),
      url: String(link?.["@_href"] ?? "").trim(),
      published: new Date(textOf(e.published) || textOf(e.updated)),
      description: plainText(textOf(e.summary) || textOf(e.content)),
      source: null,
      ownLink: true,
    });
  }
  return entries.filter((e) => e.title && /^https?:\/\//.test(e.url) && !isNaN(e.published.getTime()));
}

/** Bing News links go through a click-tracking page; its `url` parameter is the article. */
function articleUrl(link: string): string {
  try {
    const u = new URL(link);
    const target = u.hostname.endsWith("bing.com") ? u.searchParams.get("url") : null;
    return target && /^https?:\/\//.test(target) ? target : link;
  } catch {
    return link;
  }
}

async function fetchFeed(url: string): Promise<FeedEntry[]> {
  const res = await fetch(url, {
    headers: {"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml"},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`returned HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** Past 7 days, newest first: in testing this returned the most stories inside the 48-hour window. */
function bingNewsUrl(query: string): string {
  const freshness = encodeURIComponent("interval=\"8\" sortbydate=\"1\"");
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=en-US&qft=${freshness}`;
}

/** A title reduced to lower-case letters and digits, to spot the same story from two sources. */
function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 90);
}

interface Source {
  label: string;
  section: SectionKey;
  url: string;
  limit: number;
  /** The feed's own name, for items that do not name a publisher. */
  name: string;
  futures: boolean;
}

function buildSources(market: MarketSnapshot | null | undefined, preMarket: boolean): Source[] {
  const sources: Source[] = HEADLINE_FEEDS.map((f) => ({
    label: f.name, section: f.section, url: f.url, limit: f.limit ?? ITEMS_PER_FEED, name: f.name, futures: false,
  }));
  const search = (section: SectionKey, query: string, futures = false): Source => ({
    label: `Bing News: ${query}`, section, url: bingNewsUrl(query), limit: ITEMS_PER_SEARCH,
    name: "Bing News", futures,
  });
  for (const q of HEADLINE_NEWS_QUERIES) sources.push(search(q.section, q.query));
  // One search per large move, so the model has the story behind each move
  // that marketData lists as a reason the day is significant.
  for (const m of market?.movers ?? []) sources.push(search("markets", `${m.symbol} stock`));
  if (preMarket) sources.push(search("markets", "\"S&P 500 futures\"", true));
  return sources;
}

/**
 * Read every source in parallel and return the recent, de-duplicated stories.
 * A source that fails is reported in `errors` and the rest still count.
 */
export async function gatherCandidates(
  market: MarketSnapshot | null | undefined,
  preMarket: boolean,
  now = new Date()
): Promise<{candidates: Candidate[]; errors: string[]}> {
  const sources = buildSources(market, preMarket);
  const results = await Promise.allSettled(sources.map((s) => fetchFeed(s.url)));
  const cutoff = now.getTime() - WINDOW_HOURS * 3600_000;

  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const byUrl = new Map<string, Candidate>();
  const byTitle = new Map<string, Candidate>();

  results.forEach((result, i) => {
    const source = sources[i];
    if (result.status === "rejected") {
      errors.push(`${source.label}: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      return;
    }
    // Feeds are newest first by convention but not always.
    const entries = result.value
      .filter((e) => e.published.getTime() >= cutoff && e.published.getTime() <= now.getTime() + 3600_000)
      .sort((a, b) => b.published.getTime() - a.published.getTime());
    for (const e of entries.slice(0, source.limit)) {
      const key = titleKey(e.title);
      const seen = (e.ownLink ? byUrl.get(e.url) : undefined) ?? byTitle.get(key);
      if (seen) {
        // An earlier search found this story first; keep its futures mark.
        if (source.futures) seen.futures = true;
        continue;
      }
      const candidate: Candidate = {
        id: `c${candidates.length + 1}`,
        section: source.section,
        title: e.title,
        description: truncate(e.description, DESCRIPTION_CHARS),
        sourceName: e.source ?? source.name,
        url: e.url,
        published: e.published,
        futures: source.futures,
      };
      candidates.push(candidate);
      if (e.ownLink) byUrl.set(e.url, candidate);
      byTitle.set(key, candidate);
    }
  });
  return {candidates, errors};
}

// ─── Choosing and summarising ──────────────────────────────────

const SUBMIT_TOOL: Anthropic.Messages.Tool = {
  name: "submit_headlines",
  description:
    "Submit the chosen headlines. Call this exactly once, with every item you chose. " +
    "Each item names one candidate by its id.",
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
          required: ["id", "section", "headline", "summary", "whyItMatters", "futures"],
          properties: {
            id: {type: "string", description: "The candidate's id, such as \"c12\"."},
            section: {type: "string", enum: HEADLINE_SECTIONS.map((s) => s.key)},
            headline: {type: "string", description: "One line, under 100 characters."},
            summary: {type: "string", description: "One or two plain sentences on what happened."},
            whyItMatters: {type: "string", description: "One sentence on why Jack in particular should care."},
            futures: {
              type: "boolean",
              description: "True only for the pre-market S&P 500 futures report. False for every other item.",
            },
          },
        },
      },
    },
  },
};

function buildSystemPrompt(todayLabel: string): string {
  return `You are Maisie, Jack Notarangelo's executive assistant, preparing the Headlines tab of his briefing. Today is ${todayLabel} (Eastern Time).

Jack is a technical advisor on AI adoption. The user message lists candidate stories from news feeds and news searches, all from the last ${WINDOW_HOURS} hours. Choose the ones Jack should see, in three sections:

1. people — what David Sacks, Chamath Palihapitiya, Benny Johnson (the US political commentator) and Paweł Huryn (AI for product managers) have said, published or done. Skip stories about other people with the same name.
2. ai — significant news from Anthropic, OpenAI, Google DeepMind / Gemini, Meta AI, xAI, Microsoft AI and NVIDIA: model releases, major product launches, pricing changes, policy or legal news. Skip minor feature updates.
3. markets — only events that moved, or are expected to move, the S&P 500: a move of more than 1% in a day, a Federal Reserve decision, a CPI or jobs report, or earnings from one of the largest companies in the index. The user message may include marketData with the latest prices and a list of reasons the day is significant; when it does, use the candidates to explain the cause of each move it lists. Take every number from marketData, never from a headline, and do not repeat prices the dashboard already shows. If nothing significant happened, choose no markets items.

Pre-market futures: when the user message says the US market has not opened yet, choose the most recent candidate marked "futures": true that reports on S&P 500 futures, and set futures to true on it. Put the direction and size of the move in the headline, such as "S&P 500 futures down 0.6% before the open", taking the figure from that candidate. This is the one item whose numbers come from the news rather than from marketData. If there is no such candidate from today, leave it out.

Rules:
- Every item must use the id of one candidate from the list. If no candidate explains a move in marketData, leave that move out.
- Use only the facts in each candidate's title and description, and in marketData. Do not add details from memory.
- Skip stories that are not in English.
- When several candidates report the same story, choose one: the company's own announcement or the most established outlet.
- At most ${ITEMS_PER_SECTION} items per section. Prefer fewer, more important items. Choosing nothing for a section is fine.
- Write in plain English. No markdown.
- Report what people said without adding your own opinion of it.
- When you have chosen, call submit_headlines once with all the items, or with an empty list if nothing qualifies.`;
}

/** YYYY-MM-DD in Eastern Time. */
function etDateKey(d: Date): string {
  return d.toLocaleDateString("en-CA", {timeZone: "America/New_York"});
}

/**
 * Gather the candidates, have the model choose, and return the headlines.
 *
 * Throws when no source could be read, on API failure, on a refusal, or when
 * the model never calls submit_headlines, so the caller can keep the previous
 * headlines instead of overwriting them with nothing.
 */
export async function generateHeadlines(
  anthropic: Anthropic,
  model: string,
  todayLabel: string,
  marketData?: MarketSnapshot | null,
  preMarket = false
): Promise<HeadlinesResult> {
  const {candidates, errors} = await gatherCandidates(marketData, preMarket);
  if (errors.length > 0) console.warn(`[headlines] ${errors.length} source(s) failed:\n${errors.join("\n")}`);
  if (candidates.length === 0) {
    throw new Error(`No candidate stories were found. Source errors: ${errors.join("; ") || "none"}`);
  }

  const parts = ["Prepare today's headlines from these candidates."];
  if (preMarket) parts.push("The US market has not opened yet. Include the pre-market futures report.");
  parts.push(
    marketData ?
      `marketData (the latest prices; before the open these are the previous close):\n${JSON.stringify(marketData)}` :
      "No market data is available today.",
    `Candidates:\n${JSON.stringify(candidates.map((c) => ({
      id: c.id,
      section: c.section,
      source: c.sourceName,
      published: c.published.toISOString(),
      title: c.title,
      ...(c.description ? {description: c.description} : {}),
      ...(c.futures ? {futures: true} : {}),
    })))}`
  );
  const messages: Anthropic.Messages.MessageParam[] = [{role: "user", content: parts.join("\n\n")}];
  const request = (): Anthropic.Messages.MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: 16000,
    thinking: {type: "adaptive"},
    // Choosing from a list and summarising it: low is the recommended level
    // for classification and content generation.
    output_config: {effort: "low"},
    system: buildSystemPrompt(todayLabel),
    tools: [SUBMIT_TOOL],
    messages,
  });

  const usage = {inputTokens: 0, outputTokens: 0};
  let submit: Anthropic.Messages.ToolUseBlock | undefined;
  // tool_choice cannot force the call on this model, so ask once more if the
  // first reply ends without it.
  for (let attempt = 0; attempt < 2 && !submit; attempt++) {
    const response = await anthropic.messages.create(request());
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    if (response.stop_reason === "refusal") {
      throw new Error(`The model declined the headlines request (${response.stop_details?.category ?? "no category"}).`);
    }
    submit = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use" && b.name === SUBMIT_TOOL.name
    );
    if (!submit) {
      if (response.stop_reason === "max_tokens") throw new Error("The headlines reply reached max_tokens.");
      messages.push({role: "assistant", content: response.content});
      messages.push({role: "user", content: "Please call submit_headlines now with the items you chose."});
    }
  }
  if (!submit) throw new Error("submit_headlines was not called after two attempts.");

  type Pick = {id: string; section: SectionKey; headline: string; summary: string; whyItMatters: string; futures: boolean};
  const picks = (submit.input as {items?: Pick[]}).items ?? [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const used = new Set<string>();
  const items: HeadlineItem[] = [];
  for (const p of picks) {
    const c = byId.get(p.id);
    if (!c || used.has(p.id)) {
      console.warn(`[headlines] ignored a pick with ${c ? "a repeated" : "an unknown"} id: ${p.id}`);
      continue;
    }
    used.add(p.id);
    items.push({
      section: p.section,
      headline: p.headline,
      summary: p.summary,
      whyItMatters: p.whyItMatters,
      sourceName: c.sourceName,
      url: c.url,
      publishedAt: etDateKey(c.published),
      futures: preMarket && c.futures && p.futures && p.section === "markets",
    });
  }

  const estimatedCostUsd = Math.round(
    (usage.inputTokens * PRICE_PER_MTOK.input + usage.outputTokens * PRICE_PER_MTOK.output) / 1e6 * 10_000
  ) / 10_000;
  return {
    sections: HEADLINE_SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      items: items.filter((it) => it.section === s.key).slice(0, ITEMS_PER_SECTION),
    })),
    usage: {candidates: candidates.length, ...usage, estimatedCostUsd},
    sourceErrors: errors,
  };
}
