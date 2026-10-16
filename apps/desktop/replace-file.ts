import { rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

// On Windows, replacing a file fails with EPERM/EBUSY/EACCES while anything else (antivirus, an indexer, a file watcher) has it open.
// These clear within moments, so retry a few times before reporting a failure.
const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
// About two seconds in all: measured against a reader that never stops, a replace needed at most six tries (75 ms) on a fast PC,
// and a slower machine (a CI runner) needs more room. A save that waits that long still shows its "saving" state.
export const replaceDelays: readonly number[] = [10, 20, 40, 80, 120, 160, 200, 250, 300, 400, 500];

type Options = { rename?: (from: string, to: string) => Promise<void>; delays?: readonly number[] };

export async function replaceFile(from: string, to: string, { rename: move = rename, delays = replaceDelays }: Options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transient.has(code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]!);
    }
  }
}
