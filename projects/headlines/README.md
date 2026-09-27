# Headlines Tab

A second tab on the MAISIE briefing that shows what the people and companies Jack follows have said or done, and anything that moves the S&P 500.

## Status

- **Phase 1 is live** since 2026-09-27.
- **Two-week check, 2026-10-11:** Jack decides whether posts on X are missing, and so whether to add the X API.
- **To run the headlines outside the schedule:** in GitHub, go to Actions, then "Run Headlines Now", then "Run workflow". This starts `headlinesBriefing`.

## How it works

- **Schedule** (`functions/src/index.ts`): `headlinesBriefing` runs every day at 6:45 AM and 12:45 PM ET. `headlinesMarketOpen` runs on weekdays at 9:45 AM ET, 15 minutes after the market opens. Both call the same `runHeadlines`, and each run replaces the one before it.
- **Cost:** about $0.30–$0.40 per run, which is about $27 a month for the three runs.
- **`generateHeadlines`** (`functions/src/headlines.ts`) makes one Claude call with web search and web fetch. The model returns its items through a strict `submit_headlines` tool.
- **Every item must have a URL that the search or fetch actually returned.** The code drops any other item and saves it in the `unverified` field of `briefings/headlines`.
- **Results go to `briefings/headlines`**, not `briefings/live`, so the 30-minute facts refresh never overwrites them.
- **If a run fails**, the last good headlines stay on screen, and `lastError` is recorded beside them.
- **The dashboard** now has "Today" and "Headlines" tabs in the Briefing section. The browser remembers which tab was open last.

## Sources (Phase 1, kept in code)

- **People:** Paweł Huryn, David Sacks, Chamath Palihapitiya, Benny Johnson.
- **AI companies:** Anthropic, OpenAI, Google DeepMind / Gemini, Meta AI, xAI, Microsoft AI, NVIDIA.
- **Markets:** only events that move the S&P 500, such as a daily move above 1%, a Fed decision, CPI, a jobs report, or earnings from the largest companies.
- **Market prices (Phase 2, from Finnhub):** `functions/src/markets.ts` reads SPY, the fund that tracks the S&P 500, plus the eight largest companies (AAPL, MSFT, NVDA, AMZN, GOOGL, META, AVGO, TSLA) and their earnings dates for the next 7 days.
  - **The day is marked significant** when SPY moves 1% or more, one of those companies moves 3% or more, or one of them reports earnings that week. The model is then asked to find the cause of each move.
  - **The free plan has no VIX, no bond yields and no index levels.** Adding them would need a paid Finnhub plan.
  - **The key is in the GitHub secret `FINNHUB_API_KEY`.** Without it, the markets strip is simply not shown.
- **Economic calendar:** Fed rate decisions, CPI and jobs reports for the next 7 days are shown in the strip. Any of them in the week marks the day significant.
  - **Where the dates come from:** they are entered by hand in `functions/src/markets.ts`, from the Fed and BLS official schedules, because the free Finnhub plan has no economic calendar.
  - **Coverage:** the BLS dates run to December 2026 and the Fed dates to March 2027.
  - **When they run out:** 30 days before either list ends, the strip shows a note saying the dates need updating.
- **Pre-market futures (from news):** on weekdays before 9:30 AM ET, which in practice means the 6:45 AM run, the model adds one Markets item on S&P 500 futures, taken from a news report and linked to it. The dashboard labels it "Futures · from news", because the number can be 30 to 60 minutes old. The free Finnhub plan has no futures data.

## X (Twitter)

- **Three of the four people post mainly on X**: David Sacks, Chamath Palihapitiya and Benny Johnson. Web search reads X poorly.
- **Phase 1 uses their other channels**: the All-In podcast, Chamath's Substack, The Benny Show, and The Product Compass. It also uses news coverage of what they post.
- **Recommendation:** run Phase 1 for two weeks. If important posts are missing, add the X API in Phase 2. The X API is paid, so confirm the current price first.

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
