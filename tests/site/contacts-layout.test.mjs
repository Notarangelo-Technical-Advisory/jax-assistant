// Tests for the contacts page on a phone. The list and the details share one
// column there, so the details take the place of the list while a contact is
// open, with a button back to the list.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = `${root}src/app/components/contacts/`;
const template = readFileSync(`${dir}contacts.component.html`, 'utf8');
const styles = readFileSync(`${dir}contacts.component.scss`, 'utf8');

// The body of the first block that starts at `start`, with nested blocks.
function block(start) {
  const at = styles.indexOf(start);
  assert.notEqual(at, -1, `${start} is missing from the styles`);
  let depth = 0;
  for (let i = styles.indexOf('{', at); i < styles.length; i++) {
    if (styles[i] === '{') depth++;
    if (styles[i] === '}' && --depth === 0) return styles.slice(at, i + 1);
  }
  return styles.slice(at);
}

describe('contacts page on a phone', () => {
  it('marks the page when a contact is open, and has a button back to the list', () => {
    assert.match(template, /<div class="layout" \[class\.has-selection\]="selection\(\) !== null">/);
    assert.match(template, /<button class="btn-back-list" \(click\)="closeDetail\(\)">/);
  });

  it('shows the details in place of the list while a contact is open', () => {
    const phone = block('@media (max-width: 760px) {\n    grid-template-columns: 1fr;');
    assert.match(phone, /&\.has-selection \.list \{ display: none; \}/);
    assert.match(phone, /&:not\(\.has-selection\) \.detail \{ display: none; \}/);
  });

  it('shows the back button only on a phone', () => {
    const back = block('.btn-back-list {');
    assert.match(back, /^\.btn-back-list \{\s*display: none;/);
    assert.match(back, /@media \(max-width: 760px\) \{ display: block; \}/);
  });
});
