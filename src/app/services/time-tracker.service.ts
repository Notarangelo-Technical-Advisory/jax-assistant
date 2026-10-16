import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';

/** An entry already in the NTA time tracker. */
export interface TrackerEntry {
  entryId: string;
  /** HH:MM, Eastern Time. */
  start: string;
  end: string;
  hours: number;
  customer: string;
  project: string;
  description: string;
  status: 'unbilled' | 'billed' | 'paid';
  postedByMaisie: boolean;
}

export interface TrackerCustomer {
  id: string;
  name: string;
  /** Active projects only. */
  projects: Array<{ id: string; name: string }>;
}

export interface TrackerDay {
  success: boolean;
  error?: string;
  entries: TrackerEntry[];
  customers: TrackerCustomer[];
}

/** One row to draft a description for: a work session and the journal items in it. */
export interface DraftRow {
  client: string;
  date: string;
  start: string;
  end: string;
  items: Array<{ source: string; action: string; subject: string; ticket?: string | null; repo?: string | null }>;
}

/** One entry to post, in the shape add_time_entries takes. */
export interface NewTrackerEntry {
  date: string;
  customer: string;
  project: string;
  start_time: string;
  end_time: string;
  description: string;
}

export interface PostResult {
  success: boolean;
  posted?: number;
  totalHours?: number;
  error?: string;
}

const URL = 'https://timeentries-nxe253ex3a-uc.a.run.app';

/**
 * The NTA time tracker, through the timeEntries Cloud Function. The tracker is
 * another Firebase project, so the page cannot read or write it directly; the
 * function applies the same checks as Maisie's add_time_entries tool.
 */
@Injectable({ providedIn: 'root' })
export class TimeTrackerService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  getDay(day: string): Promise<TrackerDay> {
    return this.call<TrackerDay>({ action: 'day', day });
  }

  /** Maisie's description for each row, in the same order, in Jack's saved style. */
  async draft(rows: DraftRow[]): Promise<string[]> {
    const result = await this.call<{ success: boolean; descriptions?: string[]; error?: string }>({ action: 'draft', rows });
    if (!result.success || !result.descriptions) throw new Error(result.error ?? 'Maisie could not draft the descriptions.');
    return result.descriptions;
  }

  post(entries: NewTrackerEntry[]): Promise<PostResult> {
    return this.call<PostResult>({ action: 'post', entries });
  }

  /**
   * One call to the function, tried a second time when it could not be
   * reached. A Cloud Function that is new or has been idle can fail its first
   * request while it starts. Trying a post again is safe: if the first
   * attempt did save the entries, the overlap check refuses the second.
   */
  private async call<T>(body: Record<string, unknown>): Promise<T> {
    const token = await this.auth.getIdToken();
    const send = () => firstValueFrom(this.http.post<T>(URL, body, { headers: { Authorization: `Bearer ${token}` } }));
    try {
      return await send();
    } catch (first) {
      if (reasonFrom(first)) throw new Error(reasonFrom(first)!);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      try {
        return await send();
      } catch (second) {
        throw new Error(reasonFrom(second) ?? UNREACHABLE[String(body['action'])] ?? 'Maisie could not be reached. Try again in a moment.');
      }
    }
  }
}

const RETRY_DELAY_MS = 1500;

/** What the page says when the function cannot be reached twice in a row. */
const UNREACHABLE: Record<string, string> = {
  day: 'Could not load the time tracker for this day. Try again in a moment.',
  draft: 'Could not reach Maisie to draft the descriptions. Try again in a moment.',
  post: 'Could not reach the time tracker, so it is not certain the entries were posted. Try again: entries already posted are refused, not doubled.',
};

/** The reason the function gave, when it answered with one; a refusal is never retried. */
function reasonFrom(err: unknown): string | null {
  const reason = (err as { error?: { error?: unknown } }).error?.error;
  return typeof reason === 'string' ? reason : null;
}
