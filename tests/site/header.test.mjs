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
});
