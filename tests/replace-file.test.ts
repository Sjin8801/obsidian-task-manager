import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceFile } from '../apps/desktop/replace-file.ts';

const failure = (code: string) => Object.assign(new Error(code), { code });
const fast = [0, 0, 0];

test('a busy target is retried until the replacement goes through', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    let calls = 0;
    await replaceFile('a', 'b', { delays: fast, rename: async () => { if (++calls <= 2) throw failure(code); } });
    assert.equal(calls, 3, code);
  }
});

test('the failure is reported once the retries run out', async () => {
  let calls = 0;
  await assert.rejects(replaceFile('a', 'b', { delays: fast, rename: async () => { calls++; throw failure('EPERM'); } }), { code: 'EPERM' });
  assert.equal(calls, fast.length + 1);
});

test('errors that waiting cannot fix are not retried', async () => {
  for (const error of [failure('ENOENT'), failure('ENOSPC'), new Error('no code')]) {
    let calls = 0;
    await assert.rejects(replaceFile('a', 'b', { delays: fast, rename: async () => { calls++; throw error; } }), error);
    assert.equal(calls, 1);
  }
});
