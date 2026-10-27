// The recurrence fields on the task forms. A bare number box such as "3" next
// to "Monthly" does not say whether it is the day or the interval, so every
// one must sit inside a label with words that say what it means.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const template = readFileSync(`${root}src/app/components/dashboard/dashboard.component.html`, 'utf8');

/** The visible words in the label around the field bound to `model`. */
function wordsAround(model) {
  const at = template.indexOf(`[(ngModel)]="${model}"`);
  assert.notEqual(at, -1, `${model} is not on the page`);
  const open = template.lastIndexOf('<label class="recurrence-field"', at);
  const close = template.indexOf('</label>', at);
  assert.ok(open !== -1 && open > template.lastIndexOf('</label>', at), `${model} is not inside a recurrence-field label`);
  return [...template.slice(open, close).matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1].trim()).join(' … ');
}

describe('recurrence fields on the task forms', () => {
  for (const form of ['newTask', 'editingTask']) {
    it(`labels every number on the ${form === 'newTask' ? 'add' : 'edit'} form with what it means`, () => {
      assert.equal(wordsAround(`${form}RecurrenceInterval`), 'every … {{ recurrenceUnit(' + form + 'RecurrenceType) }}');
      assert.match(wordsAround(`${form}RecurrenceTimes`), /times/);
      // The day box appears twice, once for weekly and once for monthly.
      const monthly = template.indexOf(`@if (${form}RecurrenceType === 'monthly')`);
      const dayBox = template.indexOf(`[(ngModel)]="${form}RecurrenceDay"`, monthly);
      assert.match(template.slice(monthly, dayBox), /<span>on day<\/span>/);
    });
  }
});
