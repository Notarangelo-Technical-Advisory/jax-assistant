// code_with_github drafts a story and one subtask for the NTA story agent
// (functions/src/tools/story-draft.ts). GitHub is replaced by a fake that keeps
// each request, so no test opens an issue.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const fromFunctions = createRequire(new URL('../../functions/package.json', import.meta.url));
const { draftStory, briefBody, missingFields } = fromFunctions('./lib/tools/story-draft.js');

// The story agent parks a subtask whose body lacks any of these (nta-story-agent brief.py).
const BRIEF_HEADINGS = ['Goal', 'Files to change / create', 'Interfaces / contracts', 'Conventions to apply',
  'Acceptance criteria', 'Out of scope', 'Test expectations'];

const INPUT = {
  story_title: 'Show the week number on the journal page',
  story_summary: 'Jack plans by week number. The journal page should show it.',
  subtask_title: 'Add the ISO week number to the journal header',
  goal: 'The journal header shows the ISO week number of the day shown.',
  files: ['src/app/journal/journal.component.ts: add the week number', 'src/app/journal/journal.component.spec.ts: test it'],
  interfaces: 'None',
  conventions: 'AGENTS.md',
  acceptance_criteria: ['The header reads "Week 46" on 2026-11-11'],
  out_of_scope: 'The rest of the journal page.',
  test_expectations: 'A unit test in journal.component.spec.ts for a Monday and a Sunday.',
};

/** A fake GitHub that answers each POST in turn, or fails the call numbered `failAt`. */
function fakeGitHub({ failAt } = {}) {
  const calls = [];
  const replies = [
    { number: 201, id: 9001, html_url: 'https://github.com/x/issues/201' },
    { number: 202, id: 9002, html_url: 'https://github.com/x/issues/202' },
    {},
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (calls.length === failAt) return { ok: false, status: 403, text: async () => 'forbidden' };
    return { ok: true, json: async () => replies[calls.length - 1] };
  };
  return { calls, fetchImpl };
}

describe('code_with_github', () => {
  it('opens the story, then the subtask, then makes the subtask a sub-issue of the story', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    const result = await draftStory(INPUT, 'token', fetchImpl);
    assert.equal(result.success, true);
    assert.equal(result.story_url, 'https://github.com/x/issues/201');
    assert.equal(result.subtask_url, 'https://github.com/x/issues/202');
    const repo = 'https://api.github.com/repos/Notarangelo-Technical-Advisory/jax-assistant';
    assert.deepEqual(calls.map((c) => c.url),
      [`${repo}/issues`, `${repo}/issues`, `${repo}/issues/201/sub_issues`]);
    assert.equal(calls[0].body.title, 'Story: Show the week number on the journal page');
    assert.equal(calls[1].body.title, 'Add the ISO week number to the journal header');
    assert.deepEqual(calls[2].body, { sub_issue_id: 9002 });
    assert.equal(calls[0].headers.Authorization, 'Bearer token');
  });

  it('never adds a label, so nothing starts until Jack adds story-ready', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    await draftStory(INPUT, 'token', fetchImpl);
    assert.ok(calls.every((c) => c.body.labels === undefined));
    assert.doesNotMatch(calls[1].body.body, /@claude/);
  });

  it("writes every heading of the story agent's brief, with the lists as bullets", () => {
    const body = briefBody(INPUT);
    for (const heading of BRIEF_HEADINGS) assert.match(body, new RegExp(`^## ${heading}$`, 'm'));
    assert.match(body, /^- src\/app\/journal\/journal\.component\.ts: add the week number$/m);
    assert.match(body, /story-ready/);
  });

  it('refuses a brief with an empty part, before calling GitHub', async () => {
    const { calls, fetchImpl } = fakeGitHub();
    const result = await draftStory({ ...INPUT, goal: '  ', files: [''] }, 'token', fetchImpl);
    assert.equal(result.success, false);
    assert.match(result.error, /Missing: goal, files/);
    assert.equal(calls.length, 0);
    assert.deepEqual(missingFields(INPUT), []);
  });

  it('says what was already opened when a later call fails', async () => {
    const { fetchImpl } = fakeGitHub({ failAt: 3 });
    const result = await draftStory(INPUT, 'token', fetchImpl);
    assert.equal(result.success, false);
    assert.match(result.error, /403/);
    assert.match(result.error, /issues\/201 and https:\/\/github\.com\/x\/issues\/202/);
  });

  it('needs the token', async () => {
    const result = await draftStory(INPUT, undefined, fakeGitHub().fetchImpl);
    assert.equal(result.success, false);
    assert.match(result.error, /MAISIE_PAT/);
  });
});
