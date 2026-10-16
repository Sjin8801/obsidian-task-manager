/**
 * How a note is known to be a task, from the TaskNotes settings: by a tag (`taskTag`, "task" unless changed) or by one property
 * having a value (`taskIdentificationMethod: "property"` with `taskPropertyName` and `taskPropertyValue`). The rules follow
 * TaskNotes' own src/utils/taskIdentification.ts.
 */
export type TaskIdentification = { method: 'tag'; tag: string } | { method: 'property'; name: string; value: string };
export const defaultIdentification: TaskIdentification = { method: 'tag', tag: 'task' };

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const withoutHash = (tag: string) => tag.replace(/^#/, '');

/** Read from the parsed data.json. A property rule with no name or no value is incomplete, so the usual tag is used. */
export function parseIdentification(data: unknown): TaskIdentification {
  const settings = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  if (settings.taskIdentificationMethod === 'property') {
    const name = text(settings.taskPropertyName), value = text(settings.taskPropertyValue);
    return name && value ? { method: 'property', name, value } : defaultIdentification;
  }
  const tag = withoutHash(text(settings.taskTag));
  return tag ? { method: 'tag', tag } : defaultIdentification;
}

/** The tags of a note's frontmatter as written, without a leading #. A value that is not text is left out. */
export function frontmatterTags(tags: unknown): string[] {
  return (typeof tags === 'string' ? [tags] : Array.isArray(tags) ? tags : [])
    .filter((tag): tag is string => typeof tag === 'string')
    .map(withoutHash);
}

/** The task tag itself or a tag under it ("task/work"), in any case, the way TaskNotes matches it. */
export function isTaskTag(tag: string, identification: TaskIdentification): boolean {
  if (identification.method !== 'tag') return false;
  const have = tag.toLowerCase(), want = identification.tag.toLowerCase();
  return have === want || have.startsWith(want + '/');
}

export function isTaskFrontmatter(values: Record<string, unknown>, identification: TaskIdentification = defaultIdentification): boolean {
  if (identification.method === 'tag') return frontmatterTags(values.tags).some(tag => isTaskTag(tag, identification));
  const found = values[identification.name];
  // A true/false property is compared with the setting written as "true" or "false".
  const same = (value: unknown) => typeof value === 'boolean' && /^(true|false)$/i.test(identification.value)
    ? value === (identification.value.toLowerCase() === 'true')
    : value === identification.value;
  return Array.isArray(found) ? found.some(same) : found !== undefined && same(found);
}
