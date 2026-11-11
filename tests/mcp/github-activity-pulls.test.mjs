// How readGitHubActivity (functions/src/mcp/github-activity.ts) turns pull request
// and review events into journal items. Run with `npm run test:mcp`. The GitHub
// calls are a fake `api` function, so no test calls GitHub.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// src/mcp is run with tsx and never compiled, so tsx loads it here too.
const functionsDir = new URL('../../functions/', import.meta.url).pathname;
const { require: tsxRequire } = createRequire(`${functionsDir}package.json`)('tsx/cjs/api');
const { readGitHubActivity } = tsxRequire(`${functionsDir}src/mcp/github-activity.ts`, import.meta.url);

const SINCE = new Date('2026-01-01T00:00:00Z');
const PULL_PATH = 'repos/o/r/pulls/12';

/** One event, with any field replaced. */
const event = (id, type, payload, over = {}) => ({
  id, type, created_at: '2026-02-01T10:00:00Z', repo: { name: 'o/r' }, payload, ...over,
});

/** Run the reader with a fake api. `pullAnswer` is the lookup of pull request 12. */
function run(events, pullAnswer = { title: 'Looked-up title', html_url: 'https://github.com/o/r/pull/12', head: { ref: 'feature/CNG-1234-x' } }) {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    if (path === 'user') return { login: 'jack' };
    if (path === 'users/jack/events?per_page=100&page=1') return events;
    if (path === PULL_PATH) {
      if (pullAnswer instanceof Error) throw pullAnswer;
      return pullAnswer;
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { result: readGitHubActivity(SINCE, api), calls };
}

describe('pull request events', () => {
  it('journals an opened pull request with its looked-up title, branch and ticket', () => {
    const { result } = run([event('1', 'PullRequestEvent', { action: 'opened', number: 12 })]);
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.equal(item.action, 'Opened PR #12');
    assert.equal(item.subject, 'Looked-up title');
    assert.equal(item.detail, 'feature/CNG-1234-x');
    assert.equal(item.ticket, 'CNG-1234');
  });

  it('journals a closed pull request that was merged as Merged', () => {
    const { result } = run([
      event('1', 'PullRequestEvent', { action: 'closed', number: 12, pull_request: { merged: true } }),
    ]);
    assert.equal(result.items[0].action, 'Merged PR #12');
  });

  it('skips a labeled pull request and counts it as skipped', () => {
    const { result } = run([event('1', 'PullRequestEvent', { action: 'labeled', number: 12 })]);
    assert.equal(result.items.length, 0);
    assert.equal(result.skipped, 1);
  });

  it('looks a pull request title up once for two events', () => {
    const { result, calls } = run([
      event('1', 'PullRequestEvent', { action: 'opened', number: 12 }),
      event('2', 'PullRequestEvent', { action: 'closed', number: 12, pull_request: { merged: true } }),
    ]);
    assert.equal(result.items.length, 2);
    assert.equal(calls.filter((c) => c === PULL_PATH).length, 1);
  });

  it('counts a failed title lookup and falls back to the title in the event', () => {
    const { result } = run(
      [event('1', 'PullRequestEvent', { action: 'opened', number: 12, pull_request: { title: 'Event title' } })],
      new Error('HTTP 404'),
    );
    assert.equal(result.lookupFailures, 1);
    assert.equal(result.items[0].subject, 'Event title');
  });
});

describe('pull request review events', () => {
  const review = (state) =>
    event('1', 'PullRequestReviewEvent', { pull_request: { number: 12 }, review: { state } });

  it('journals an approved review as Approved', () => {
    const { result } = run([review('approved')]);
    assert.equal(result.items[0].action, 'Approved PR #12');
  });

  it('journals a review that asks for changes as Requested changes', () => {
    const { result } = run([review('changes_requested')]);
    assert.equal(result.items[0].action, 'Requested changes on PR #12');
  });
});
