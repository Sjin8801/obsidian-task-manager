import assert from 'node:assert/strict';
import test from 'node:test';
import { joinBody, splitBody } from '../apps/desktop/renderer/body-text.ts';

test('the blank line TaskNotes puts after the properties is hidden from the editor and restored on save', () => {
  const { lead, text } = splitBody('\n\nFirst line\n\nSecond line\n');
  assert.equal(text, 'First line\n\nSecond line\n');
  assert.equal(lead, '\n\n');
  assert.equal(joinBody(lead, text), '\n\nFirst line\n\nSecond line\n');
});

test('an unedited body round-trips byte for byte, whatever separator the note used', () => {
  for (const body of ['\n\ntext', '\ntext', 'text', '\n\n\ntext', '\n\ntext\n\n']) {
    const { lead, text } = splitBody(body);
    assert.equal(joinBody(lead, text), body, JSON.stringify(body));
  }
});

test('only the separator is hidden; blank lines inside the text stay', () => {
  assert.equal(splitBody('\n\n\n\nkept').text, 'kept');
  assert.equal(splitBody('\n\nA\n\n\nB').text, 'A\n\n\nB');
});

test('a note with no text gets the usual blank line when text is added', () => {
  for (const body of ['', '\n', '\n\n']) {
    const { lead, text } = splitBody(body);
    assert.equal(text, '');
    assert.equal(joinBody(lead, 'new text'), '\n\nnew text', JSON.stringify(body));
  }
});
