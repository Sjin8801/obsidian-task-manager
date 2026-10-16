import { useTimeZone } from '../packages/contracts/dates.ts';

// Loaded before every test file (see the test script in package.json). The tests were written with Seoul days in mind, and the app
// follows the PC's time zone, so they pin Seoul to give the same answers on any machine (CI runs in UTC). tests/time-zone.test.ts
// checks the PC's own zone and other zones.
useTimeZone('Asia/Seoul');
