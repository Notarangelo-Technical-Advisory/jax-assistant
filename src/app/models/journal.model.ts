/**
 * The work journal. Same shapes as functions/src/tools/journal.ts, which the
 * journal job on Jack's Mac writes with; the page only reads them.
 */

export type JournalSource = 'github' | 'jira' | 'claude';

/** One piece of work: a pull request, a Jira change, a Claude Code session. */
export interface JournalItem {
  id?: string;
  source: JournalSource;
  sourceId: string;
  /** A task category key, such as 'ihrdc'. */
  client: string;
  /** YYYY-MM-DD in Eastern Time. */
  day: string;
  /** ISO timestamp. */
  at: string;
  /** Claude Code only: when the session's last activity was. */
  endAt: string | null;
  /** What Jack did: "Opened PR #674", "Moved CNG-7183 to Code Review". */
  action: string;
  /** What it was about: the pull request title, the Jira summary, the session title. */
  subject: string;
  detail: string | null;
  /** http(s) only. */
  url: string | null;
  repo: string | null;
  ticket: string | null;
}

/** Items less than 20 minutes apart, counted as one stretch of work. */
export interface WorkSession {
  start: string;
  end: string;
  minutes: number;
  itemCount: number;
}

export interface JournalClientDay {
  client: string;
  label: string;
  minutes: number;
  itemCount: number;
  sessions: WorkSession[];
}

/** A journalDays document: one day's estimated time, per client. */
export interface JournalDay {
  id?: string;
  day: string;
  /** Across all clients, counting overlapping work once. */
  totalMinutes: number;
  itemCount: number;
  /** Most time first. */
  clients: JournalClientDay[];
}
