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

  private async call<T>(body: Record<string, unknown>): Promise<T> {
    const token = await this.auth.getIdToken();
    try {
      return await firstValueFrom(this.http.post<T>(URL, body, { headers: { Authorization: `Bearer ${token}` } }));
    } catch (err) {
      // The function answers a failed draft with a reason; show it rather than an HTTP code.
      const reason = (err as { error?: { error?: string } }).error?.error;
      throw new Error(reason ?? 'The time tracker could not be reached.');
    }
  }
}
