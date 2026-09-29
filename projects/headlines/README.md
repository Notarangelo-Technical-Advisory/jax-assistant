# Headlines Tab

A second tab on the MAISIE briefing that shows what the people and companies Jack follows have said or done, and anything that moves the S&P 500.

## Status

- **Phase 1 is live** since 2026-09-27.
- **Since 2026-09-29, code gathers the stories from news feeds**, and one small model call chooses and summarises them. Before, the model searched the web itself; see "Why feeds, not web search" below.
- **Two-week check, 2026-10-11:** Jack decides whether posts on X are missing, and so whether to add the X API.
- **To run the headlines outside the schedule:** in GitHub, go to Actions, then "Run Headlines Now", then "Run workflow". This starts `headlinesBriefing`.

## How it works

- **Schedule** (`functions/src/index.ts`): `headlinesBriefing` runs every day at 6:45 AM and 12:45 PM ET. `headlinesMarketOpen` runs on weekdays at 9:45 AM ET, 15 minutes after the market opens. Both call the same `runHeadlines`, and each run replaces the one before it.
- **Cost:** estimated at 3 to 5 cents per run, which is about $4 a month for the three runs. Each run records its real token use and estimated cost in the `usage` field of `briefings/headlines`, and in the function log.
- **`gatherCandidates`** (`functions/src/headlines.ts`) reads every feed and Google News search in parallel. It keeps stories from the last 48 hours, at most 5 per feed and 8 per search, and removes duplicates. On 2026-09-29 this gave 111 stories in under a second, about 6,000 tokens.
- **`generateHeadlines`** sends those stories to one Claude call with no web tools, at low effort. The model chooses at most 4 per section and writes the headline, summary and "why it matters" lines, returning them through a strict `submit_headlines` tool.
- **Every link comes from a feed.** The model names a story by its id, and the code copies the link, source and date from that story. The model cannot write a link that does not exist.
- **The model uses only what the feeds say.** It sees each story's title and short description, not the full article, and is told not to add details from memory.
- **A feed that fails** is listed in the `sourceErrors` field, and the other sources still count. The run fails only when no source can be read.
- **Results go to `briefings/headlines`**, not `briefings/live`, so the 30-minute facts refresh never overwrites them.
- **If a run fails**, the last good headlines stay on screen, and `lastError` is recorded beside them.
- **The dashboard** now has "Today" and "Headlines" tabs in the Briefing section. The browser remembers which tab was open last.

## Sources (kept in code, `HEADLINE_FEEDS` and `HEADLINE_NEWS_QUERIES`)

- **People:** Paweł Huryn, David Sacks, Chamath Palihapitiya, Benny Johnson.
  - **Feeds:** The Product Compass, the All-In podcast, Chamath's Substack and The Benny Show.
  - **Google News searches** for each name. These also catch posts on X that the press reports.
  - **The Benny Show gives its episodes no web link**, so they link to the show's page.
- **AI companies:** Anthropic, OpenAI, Google DeepMind / Gemini, Meta AI, xAI, Microsoft AI, NVIDIA.
  - **Feeds:** OpenAI, Google DeepMind, Google's AI blog and NVIDIA's blog.
  - **Google News searches** for all seven. Anthropic has no feed, and Microsoft's blog refuses automated readers.
- **Markets:** only events that move the S&P 500, such as a daily move above 1%, a Fed decision, CPI, a jobs report, or earnings from the largest companies.
  - **Google News searches** for "stock market today" and for Fed, CPI and jobs-report news, plus one search for each large mover in the Finnhub data.
- **Market prices (Phase 2, from Finnhub):** `functions/src/markets.ts` reads SPY, the fund that tracks the S&P 500, plus the eight largest companies (AAPL, MSFT, NVDA, AMZN, GOOGL, META, AVGO, TSLA) and their earnings dates for the next 7 days.
  - **The day is marked significant** when SPY moves 1% or more, one of those companies moves 3% or more, or one of them reports earnings that week. The model is then asked to explain each move from the news stories.
  - **The free plan has no VIX, no bond yields and no index levels.** Adding them would need a paid Finnhub plan.
  - **The key is in the GitHub secret `FINNHUB_API_KEY`.** Without it, the markets strip is simply not shown.
- **Economic calendar:** Fed rate decisions, CPI and jobs reports for the next 7 days are shown in the strip. Any of them in the week marks the day significant.
  - **Where the dates come from:** they are entered by hand in `functions/src/markets.ts`, from the Fed and BLS official schedules, because the free Finnhub plan has no economic calendar.
  - **Coverage:** the BLS dates run to December 2026 and the Fed dates to March 2027.
  - **When they run out:** 30 days before either list ends, the strip shows a note saying the dates need updating.
- **Pre-market futures (from news):** on weekdays before 9:30 AM ET, which in practice means the 6:45 AM run, code adds a Google News search for "S&P 500 futures", and the model chooses one of those reports as a Markets item. The dashboard labels it "Futures · from news", because the number can be 30 to 60 minutes old. The free Finnhub plan has no futures data.

## X (Twitter)

- **Three of the four people post mainly on X**: David Sacks, Chamath Palihapitiya and Benny Johnson. X has no free feed.
- **The headlines use their other channels**: the All-In podcast, Chamath's Substack, The Benny Show, and The Product Compass. They also use news coverage of what they post.
- **Recommendation:** run Phase 1 for two weeks. If important posts are missing, add the X API in Phase 2. The X API is paid, so confirm the current price first.

## Why feeds, not web search

- **Web search cost $2 to $5 a run, against an estimate of $0.30 to $0.40.** Each run made up to 15 searches and 5 page fetches, and the model re-read everything it had found at every step. Jack's API charges were about $10.50 to $10.90 a day after the tab went live.
- **Web search runs took 4 to 9 minutes.** The 6:45 AM run on 2026-09-28 reached the 9-minute function limit and failed after it had been paid for.
- **Feeds give the same sources for a few cents**, with links that cannot be invented. The model is still needed to choose the important stories from about 100 and to write the summaries.

## Next phases

- **Phase 2:**
  - Done: Finnhub market prices and the earnings calendar.
  - Done: Fed, CPI and jobs-report dates, from the official schedules.
  - Still to do: the X API, if the two-week check shows it is needed.
- **Phase 3:**
  - The source list moves to Firestore (`headlineSources`), so Jack can edit it from chat.
  - A `get_headlines` chat and MCP tool.
  - Removing stories repeated across days.
  - Optional text-to-speech for the headlines.

## Open decisions

- **Jack:** whether to add the X API after the two-week check.
