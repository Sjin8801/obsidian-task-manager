import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Every text the code hands to the translator: t('...'), tm('...'), r('...'), t()('...') and N('...') (a text marked for later).
 * Used by tests/i18n.test.ts to check the English texts against what the code asks for.
 */
const call = /(?:\b(?:t|tm|r|N)\(|\bt\(\)\()\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)/g;

/** The text of a quoted string literal: the quotes off and the escapes (\n, \', \\ …) read. */
function unquote(literal: string): string {
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r' };
  return literal.slice(1, -1).replace(/\\(.)/g, (_match, character: string) => escapes[character] ?? character);
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** The texts, each with the files that use it. The English table itself and the tests are not read. */
export function collectSources(root = process.cwd()): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const directory of ['apps', 'packages']) {
    for (const file of files(path.join(root, directory))) {
      if (file.endsWith(path.join('i18n', 'en.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(call)) {
        const source = unquote(match[1]!);
        found.set(source, [...(found.get(source) ?? []), path.relative(root, file).replaceAll('\\', '/')]);
      }
    }
  }
  return found;
}
