// Tests for the controls in the dashboard header. The call button shows only
// a phone icon, so its name must come from aria-label for screen readers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(`${root}src/app/components/dashboard/dashboard.component.html`, 'utf8');

describe('dashboard header call button', () => {
  const button = template.match(/<button[^>]*class="btn-call-header"[\s\S]*?<\/button>/)?.[0] ?? '';

  it('is on the page', () => {
    assert.ok(button, 'the call button is missing from the dashboard header');
  });

  it('shows the phone icon without any words', () => {
    const visibleText = button.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim();
    assert.equal(visibleText, '');
    assert.match(button, /<svg[^>]*aria-hidden="true"/, 'the icon should be hidden from screen readers');
  });

  it('is named "Call Maisie" for screen readers', () => {
    assert.match(button, /aria-label="Call Maisie"/);
  });

  it('sits on the right of the header, just left of the speaker button', () => {
    const actions = template.slice(template.indexOf('<div class="header-actions">'));
    const callAt = actions.search(/<button\s+class="btn-call-header"/);
    const speakerAt = actions.lastIndexOf('<button', actions.indexOf('(click)="toggleMute()"'));
    assert.ok(callAt >= 0, 'the call button should be in the right-hand header controls');
    assert.ok(callAt < speakerAt, 'the call button should come before the speaker button');
    const between = actions.slice(callAt, speakerAt).replace(/^<button[\s\S]*?<\/button>/, '');
    assert.doesNotMatch(between, /<(button|a|select)\b/, 'nothing should sit between the call and speaker buttons');
  });
});
