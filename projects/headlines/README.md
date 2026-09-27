# Headlines Tab

A second tab on the MAISIE briefing that shows what the people and companies Jack follows have said or done, and anything that moves the S&P 500.

## Status

- **Phase 1 is built** on branch `claude/maisie-headlines-tab-ktip8n`. It is not yet deployed.

## How it works

- **`headlinesBriefing`** (`functions/src/index.ts`) runs every day at 6:45 AM and 12:45 PM ET.
- **`generateHeadlines`** (`functions/src/headlines.ts`) makes one Claude call with web search and web fetch. The model returns its items through a strict `submit_headlines` tool.
- **Every item must have a URL that the search or fetch actually returned.** The code drops any other item and logs how many it dropped.
- **Results go to `briefings/headlines`**, not `briefings/live`, so the 30-minute facts refresh never overwrites them.
- **If a run fails**, the last good headlines stay on screen, and `lastError` is recorded beside them.
- **The dashboard** now has "Today" and "Headlines" tabs in the Briefing section. The browser remembers which tab was open last.

## Sources (Phase 1, kept in code)

- **People:** Paweł Huryn, David Sacks, Chamath Palihapitiya, Benny Johnson.
- **AI companies:** Anthropic, OpenAI, Google DeepMind / Gemini, Meta AI, xAI, Microsoft AI, NVIDIA.
- **Markets:** only events that move the S&P 500, such as a daily move above 1%, a Fed decision, CPI, a jobs report, or earnings from the largest companies. It shows no prices until Phase 2.

## X (Twitter)

- **Three of the four people post mainly on X**: David Sacks, Chamath Palihapitiya and Benny Johnson. Web search reads X poorly.
- **Phase 1 uses their other channels**: the All-In podcast, Chamath's Substack, The Benny Show, and The Product Compass. It also uses news coverage of what they post.
- **Recommendation:** run Phase 1 for two weeks. If important posts are missing, add the X API in Phase 2. The X API is paid, so confirm the current price first.

## Next phases

- **Phase 2:**
  - A market data API for the S&P 500, VIX, 10-year yield and oil, with rules for what counts as "significant".
  - An events calendar for the coming week.
  - The X API, if the two-week check shows it is needed.
- **Phase 3:**
  - The source list moves to Firestore (`headlineSources`), so Jack can edit it from chat.
  - A `get_headlines` chat and MCP tool.
  - Removing stories repeated across days.
  - Optional text-to-speech for the headlines.

## Open decisions

- **Jack:** which market data provider to use. The recommendation is a free tier such as Finnhub or Alpha Vantage, because the function makes only two calls a day.
- **Jack:** whether to add the X API after the two-week check.
