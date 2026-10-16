import { mkdir, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';

// Draws assets/icon.png, the app icon of the installer, the Start menu and the taskbar: the tray's white tick on its plum colour, as a
// rounded square. Run with `node --import tsx scripts/make-icon.ts`; the result is committed, so this only runs when the icon changes.
const size = 512, samples = 4;
const plum = [139, 97, 112], white = [245, 245, 245];

// The tick as two thick strokes, in a 0..1 square.
const strokes: [number, number, number, number][] = [[0.27, 0.52, 0.43, 0.68], [0.43, 0.68, 0.74, 0.35]];
const width = 0.075, radius = 0.2;
function distanceToSegment(x: number, y: number, [ax, ay, bx, by]: [number, number, number, number]) {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}
function insideSquare(x: number, y: number) {
  const cx = Math.min(Math.max(x, radius), 1 - radius), cy = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

const rows: Buffer[] = [];
for (let py = 0; py < size; py++) {
  const row = Buffer.alloc(1 + size * 4); // filter byte 0, then RGBA
  for (let px = 0; px < size; px++) {
    let cover = 0, tick = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = (px + (sx + 0.5) / samples) / size, y = (py + (sy + 0.5) / samples) / size;
      if (!insideSquare(x, y)) continue;
      cover++;
      if (strokes.some(s => distanceToSegment(x, y, s) <= width / 2)) tick++;
    }
    const n = samples * samples, mix = cover ? tick / cover : 0;
    for (let c = 0; c < 3; c++) row[1 + px * 4 + c] = Math.round(plum[c]! * (1 - mix) + white[c]! * mix);
    row[1 + px * 4 + 3] = Math.round((cover / n) * 255);
  }
  rows.push(row);
}

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
await mkdir('assets', { recursive: true });
await writeFile('assets/icon.png', png);
console.log('Wrote assets/icon.png.');
