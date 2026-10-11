import { Headlines } from '../../models/briefing.model';

/** The note at the foot of the Headlines tab: how many stories there were to choose from, and which sources failed. */
export interface HeadlineSourceNote {
  summary: string;
  errors: string[];
  /** True when any source failed, so the note is shown as a warning. */
  warning: boolean;
}

/**
 * When few headlines appear, this says whether the sources failed or there
 * was simply little news. Returns null for documents written before the
 * headlines run recorded its usage and source errors.
 */
export function headlineSourceNote(h: Headlines | null | undefined): HeadlineSourceNote | null {
  if (!h || (h.usage === undefined && h.sourceErrors === undefined)) return null;
  const errors = h.sourceErrors ?? [];
  const parts: string[] = [];
  const n = h.usage?.candidates;
  if (n !== undefined) parts.push(`Chosen from ${n} ${n === 1 ? 'story' : 'stories'}`);
  parts.push(errors.length === 0
    ? 'every source answered'
    : `${errors.length} ${errors.length === 1 ? 'source' : 'sources'} could not be read`);
  const summary = parts.join(' · ');
  return { summary: summary.charAt(0).toUpperCase() + summary.slice(1) + '.', errors, warning: errors.length > 0 };
}
