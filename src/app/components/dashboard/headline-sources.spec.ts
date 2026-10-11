import { headlineSourceNote } from './headline-sources';

// The note at the foot of the Headlines tab, which says whether a thin tab
// means the news sources failed or there was simply little news.

describe('headlineSourceNote', () => {
  it('says how many stories there were and that every source answered', () => {
    expect(headlineSourceNote({ usage: { candidates: 138, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, sourceErrors: [] }))
      .toEqual({ summary: 'Chosen from 138 stories · every source answered.', errors: [], warning: false });
  });

  it('warns and lists each source that could not be read', () => {
    const errors = ['CNBC: returned HTTP 403', 'Bing News: OpenAI: fetch failed'];
    expect(headlineSourceNote({ usage: { candidates: 12, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, sourceErrors: errors }))
      .toEqual({ summary: 'Chosen from 12 stories · 2 sources could not be read.', errors, warning: true });
  });

  it('uses the singular for one story and one failed source', () => {
    expect(headlineSourceNote({ usage: { candidates: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, sourceErrors: ['CNBC: timed out'] })!.summary)
      .toBe('Chosen from 1 story · 1 source could not be read.');
  });

  it('still reports failed sources when the story count is missing', () => {
    expect(headlineSourceNote({ sourceErrors: ['CNBC: timed out'] })!.summary).toBe('1 source could not be read.');
  });

  it('shows nothing for headlines written before the run recorded its sources', () => {
    expect(headlineSourceNote({ sections: [] })).toBeNull();
    expect(headlineSourceNote(null)).toBeNull();
  });
});
