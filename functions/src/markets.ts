// ─── Market snapshot (Finnhub) ─────────────────────────────────
//
// Prices come from a market data API, not web search: search results give
// stale or wrong numbers. Finnhub's free plan covers US stock and ETF quotes
// and the earnings calendar, but not index levels (^GSPC, ^VIX) or bond
// yields, so the S&P 500 is read through SPY, the ETF that tracks it.
//
// Ten calls per run (nine quotes and one calendar), well inside the free
// plan's 60 calls a minute.

const FINNHUB = "https://finnhub.io/api/v1";

/** The ETF used as the S&P 500's stand-in. */
export const INDEX_PROXY = "SPY";

/**
 * The largest companies in the index. Together they are roughly a third of
 * it, so a big move or an earnings report from one of them moves the S&P 500.
 */
export const MEGA_CAPS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA"];

/** When the day is "significant" — the thresholds from projects/headlines/README.md. */
export const INDEX_MOVE_PCT = 1;
export const MEGA_CAP_MOVE_PCT = 3;
const EARNINGS_DAYS_AHEAD = 7;

export interface Quote {
  symbol: string;
  price: number;
  changePct: number;
  /** ISO time of the last trade — Friday's close on a weekend. */
  asOf: string | null;
}

export interface EarningsEvent {
  symbol: string;
  date: string;
  /** "bmo" before market open, "amc" after close, "dmh" during hours, or "". */
  hour: string;
}

// ─── Economic calendar ─────────────────────────────────────────
//
// Finnhub's free plan has no economic calendar, so these come from the
// official schedules: the Fed's FOMC calendar
// (federalreserve.gov/monetarypolicy/fomccalendars.htm) and the BLS release
// schedules (bls.gov/schedule/news_release/cpi.htm and empsit.htm).
// Entered 2026-09-27. Each date was checked against at least two sources;
// Jack confirmed the 2026-11-10 CPI date on bls.gov.
//
// The Fed posts the next year's meetings in summer; BLS posts the next
// year's releases late in the year. When either list is within 30 days of
// running out, the snapshot sets calendarNeedsUpdate and the dashboard says so.

export interface EconomicEvent {
  date: string;
  /** Eastern Time, as printed on the official schedule. */
  time: string;
  kind: "fomc" | "cpi" | "jobs";
  label: string;
}

const FOMC: EconomicEvent[] = [
  {date: "2026-10-28", time: "2:00 PM", kind: "fomc", label: "Fed rate decision"},
  {date: "2026-12-09", time: "2:00 PM", kind: "fomc", label: "Fed rate decision and projections"},
  // 2027 dates are tentative until the Fed confirms each at the meeting before.
  {date: "2027-01-27", time: "2:00 PM", kind: "fomc", label: "Fed rate decision"},
  {date: "2027-03-17", time: "2:00 PM", kind: "fomc", label: "Fed rate decision and projections"},
];

const BLS: EconomicEvent[] = [
  {date: "2026-10-02", time: "8:30 AM", kind: "jobs", label: "Jobs report (September)"},
  {date: "2026-10-14", time: "8:30 AM", kind: "cpi", label: "CPI (September)"},
  {date: "2026-11-06", time: "8:30 AM", kind: "jobs", label: "Jobs report (October)"},
  {date: "2026-11-10", time: "8:30 AM", kind: "cpi", label: "CPI (October)"},
  {date: "2026-12-04", time: "8:30 AM", kind: "jobs", label: "Jobs report (November)"},
  {date: "2026-12-10", time: "8:30 AM", kind: "cpi", label: "CPI (November)"},
];

const CALENDAR_WARNING_DAYS = 30;

function upcomingEconomicEvents(todayKey: string): {events: EconomicEvent[]; needsUpdate: boolean} {
  const until = addDays(todayKey, EARNINGS_DAYS_AHEAD);
  const events = [...FOMC, ...BLS]
    .filter((e) => e.date >= todayKey && e.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date));
  const warnFrom = addDays(todayKey, CALENDAR_WARNING_DAYS);
  const needsUpdate = [FOMC, BLS].some((list) => list[list.length - 1].date < warnFrom);
  return {events, needsUpdate};
}

export interface MarketSnapshot {
  index: Quote | null;
  /** Mega caps that moved more than MEGA_CAP_MOVE_PCT, largest move first. */
  movers: Quote[];
  upcomingEarnings: EarningsEvent[];
  /** Fed decisions, CPI and jobs reports in the next 7 days. */
  upcomingEvents: EconomicEvent[];
  /** True when the hand-entered economic calendar is about to run out. */
  calendarNeedsUpdate: boolean;
  significant: boolean;
  /** Plain-English reasons the day counts as significant; empty when it does not. */
  reasons: string[];
}

async function finnhub<T>(path: string, apiKey: string): Promise<T> {
  const res = await fetch(`${FINNHUB}${path}`, {headers: {"X-Finnhub-Token": apiKey}});
  if (!res.ok) throw new Error(`Finnhub ${path.split("?")[0]} returned ${res.status}`);
  return res.json() as Promise<T>;
}

async function getQuote(symbol: string, apiKey: string): Promise<Quote | null> {
  const q = await finnhub<{c: number; dp: number | null; t: number}>(
    `/quote?symbol=${encodeURIComponent(symbol)}`, apiKey
  );
  // Finnhub answers an unknown or unsupported symbol with all zeros, not an error.
  if (!q.c || q.dp === null) return null;
  return {
    symbol,
    price: q.c,
    changePct: Math.round(q.dp * 100) / 100,
    asOf: q.t ? new Date(q.t * 1000).toISOString() : null,
  };
}

/**
 * Fetch the snapshot. A single failed call leaves its part empty instead of
 * failing the whole run — the headlines are still worth writing without it.
 */
export async function getMarketSnapshot(apiKey: string, todayKey: string): Promise<MarketSnapshot> {
  const [indexResult, ...megaResults] = await Promise.allSettled(
    [INDEX_PROXY, ...MEGA_CAPS].map((s) => getQuote(s, apiKey))
  );

  const index = indexResult.status === "fulfilled" ? indexResult.value : null;
  if (indexResult.status === "rejected") console.warn("[markets] index quote failed:", indexResult.reason);

  const movers = megaResults
    .flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []))
    .filter((q) => Math.abs(q.changePct) >= MEGA_CAP_MOVE_PCT)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

  let upcomingEarnings: EarningsEvent[] = [];
  try {
    const to = addDays(todayKey, EARNINGS_DAYS_AHEAD);
    const cal = await finnhub<{earningsCalendar?: EarningsEvent[]}>(
      `/calendar/earnings?from=${todayKey}&to=${to}`, apiKey
    );
    upcomingEarnings = (cal.earningsCalendar ?? [])
      .filter((e) => MEGA_CAPS.includes(e.symbol))
      .map((e) => ({symbol: e.symbol, date: e.date, hour: e.hour ?? ""}))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.warn("[markets] earnings calendar failed:", err);
  }

  const reasons: string[] = [];
  if (index && Math.abs(index.changePct) >= INDEX_MOVE_PCT) {
    reasons.push(`The S&P 500 (SPY) moved ${signed(index.changePct)}%.`);
  }
  for (const m of movers) reasons.push(`${m.symbol} moved ${signed(m.changePct)}%.`);
  for (const e of upcomingEarnings) reasons.push(`${e.symbol} reports earnings on ${e.date}.`);

  const {events: upcomingEvents, needsUpdate: calendarNeedsUpdate} = upcomingEconomicEvents(todayKey);
  for (const e of upcomingEvents) reasons.push(`${e.label} on ${e.date} at ${e.time} ET.`);
  if (calendarNeedsUpdate) {
    console.warn("[markets] the economic calendar in markets.ts is within 30 days of running out");
  }

  return {
    index, movers, upcomingEarnings, upcomingEvents, calendarNeedsUpdate,
    significant: reasons.length > 0, reasons,
  };
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** YYYY-MM-DD plus n days, done in UTC so no time zone can shift the date. */
function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
