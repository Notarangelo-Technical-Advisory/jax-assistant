/** `linkedin/week` — the coming Tuesday's post, written by Cloud Functions. */
export interface LinkedInWeek {
  tuesday: string;
  title: string | null;
  status: 'idea' | 'drafted' | 'approved' | 'posted' | null;
  stage: 'no-row' | 'not-drafted' | 'needs-approval' | 'approved' | 'post-today' | 'missing-today' | 'posted';
  draft: {
    path: string;
    post: string;
    firstComment: string;
    image: string;
    extras?: Array<{ heading: string; text: string }>;
    placeholders: string[];
  } | null;
  draftUrl: string | null;
  remaining: number;
  lowQueue: boolean;
  postUrl: string | null;
}
