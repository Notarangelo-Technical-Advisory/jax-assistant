// Tests for the dashboard layout. Until Maisie is called, the chat panel is
// not on the page and the main area uses the full width.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = `${root}src/app/components/dashboard/`;
const template = readFileSync(`${dir}dashboard.component.html`, 'utf8');
const styles = readFileSync(`${dir}dashboard.component.scss`, 'utf8');

// The body of the first top-level SCSS rule with this selector.
function rule(selector) {
  const start = styles.search(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{`, 'm'));
  assert.notEqual(start, -1, `${selector} has no styles`);
  let depth = 0;
  for (let i = styles.indexOf('{', start); i < styles.length; i++) {
    if (styles[i] === '{') depth++;
    if (styles[i] === '}' && --depth === 0) return styles.slice(start, i + 1);
  }
  return styles.slice(start);
}

describe('dashboard layout before Maisie is called', () => {
  it('leaves the chat panel off the page until the chat is opened', () => {
    assert.match(template, /@if \(chatOpen\(\)\) \{\s*<div class="panel-right">/);
  });

  it('lets the main area use the full width of the page', () => {
    assert.match(rule('.panel-left'), /flex:\s*1;/);
    assert.doesNotMatch(rule('.panel-left'), /max-width/);
    assert.doesNotMatch(rule('.two-panel'), /max-width/);
  });
});
