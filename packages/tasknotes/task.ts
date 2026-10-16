import { createHash } from 'node:crypto';
import { isMap, isScalar, isSeq, Scalar, parseDocument, stringify, type YAMLMap } from 'yaml';
import { hasTag, personalTags, statusKey, workTags } from '../contracts/task.ts';
import { dateKey, isCalendarDate, isOverdue, localDate as localDateOf, timeZone } from '../contracts/dates.ts';
import { defaultStatuses, findStatus, type StatusOption } from '../contracts/statuses.ts';
import { aliasFieldNames, defaultFieldNames, defaultRelationFieldNames, koreanFieldNames, logicalFields, relationAliases, type FieldNames, type LogicalField, type RelationFieldNames } from '../contracts/fields.ts';
import { defaultIdentification, frontmatterTags, isTaskFrontmatter, type TaskIdentification } from '../contracts/identification.ts';
import { readBlockedBy, readProjects } from './relations.ts';
import type { Priority, TaskList, TaskRecord, TaskScope, TaskState } from '../contracts/task.ts';

export class TaskDataError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function validatePath(path: string): string {
  if (!path.endsWith('.md') || /[\\\u0000-\u001f:<>"|?*]/u.test(path) ||
      path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) {
    throw new TaskDataError('INVALID_PATH');
  }
  return path;
}

export function revisionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function frontmatter(raw: string) {
  const match = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?=\r?\n|$))([\s\S]*)$/.exec(raw);
  if (!match) throw new TaskDataError('MISSING_FRONTMATTER');
  const prefix = match[1]!, yaml = match[2]!, suffix = match[3]!, body = match[4]!;
  const document = parseDocument(yaml, { uniqueKeys: true, keepSourceTokens: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new TaskDataError('INVALID_FRONTMATTER');
  }
  let values: Record<string, unknown>;
  try { values = document.toJS({ maxAliasCount: 50 }) as Record<string, unknown>; }
  catch { throw new TaskDataError('INVALID_FRONTMATTER'); }
  return { prefix, yaml, suffix, body, document, values };
}

/** Ordinary vault notes are not read errors; malformed frontmatter still is. */
export function isTaskNote(raw: string, identification: TaskIdentification = defaultIdentification): boolean {
  if (!/^\uFEFF?---[ \t]*\r?\n/.test(raw)) return false;
  return isTaskFrontmatter(frontmatter(raw).values, identification);
}

export { isCalendarDate, dateKey };
export function localDate(instant: Date): string {
  if (Number.isNaN(instant.valueOf())) throw new TaskDataError('INVALID_DATE');
  return localDateOf(instant);
}

const isLogical = (key: string): key is LogicalField => (logicalFields as readonly string[]).includes(key);
/** Every name a field may be stored under, in the order they are tried: this vault's name, TaskNotes' own, then the other spellings. */
function namesFor(key: string, fields: FieldNames): string[] {
  return isLogical(key) ? [...new Set([fields[key], key, ...aliasFieldNames[key]])] : [key];
}
function fieldName(values: Record<string, unknown>, key: string, fields: FieldNames): string {
  const present = namesFor(key, fields).find(name => Object.hasOwn(values, name));
  if (present) return present;
  // The note holds none of this field. If its other fields are not under this vault's names but all under TaskNotes' own, or all under the
  // Korean ones, this one is added the same way, so a note is not left with two spellings; otherwise it goes under this vault's name.
  const primary = logicalFields.filter(k => k !== 'dateModified');
  const uses = (name: (k: LogicalField) => string) => primary.some(k => Object.hasOwn(values, name(k)));
  if (!uses(k => fields[k])) {
    if (isLogical(key) && uses(k => defaultFieldNames[k])) return defaultFieldNames[key];
    // The Korean names count as this vault's own unless the settings give this field another name.
    if (isLogical(key) && fields[key] === defaultFieldNames[key] && uses(k => koreanFieldNames[k])) return koreanFieldNames[key];
  }
  return isLogical(key) ? fields[key] : key;
}
/** Map logical edits to the property names this note uses, keeping mixed names consistent. */
export function previewTaskPatch(raw: string, expectedRevision: string, patch: Record<string, string | null>, fields: FieldNames = defaultFieldNames): string {
  const { values } = frontmatter(raw);
  const translated: Record<string, string | null | undefined> = {};
  const englishStatuses = new Map([['없음', 'none'], ['시작', 'open'], ['진행 중', 'in-progress'], ['완료', 'done']]);
  for (const [key, value] of Object.entries(patch)) {
    const existing = namesFor(key, fields).filter(k => Object.hasOwn(values, k));
    // Clearing a value takes the property out, as TaskNotes does, instead of leaving `key: null` behind.
    if (value === null) { for (const target of existing) translated[target] = undefined; continue; }
    for (const target of existing.length ? existing : [fieldName(values, key, fields)]) {
      translated[target] = target === 'status' ? englishStatuses.get(value) ?? value : value;
    }
  }
  return previewScalarPatch(raw, expectedRevision, translated, Object.values(fields));
}

// Properties of a repeating task or of a note made from one of its occurrences (TaskNotes writes both spellings). Completing an
// occurrence note also has to update its parent's complete_instances and may create the next note, so the app leaves all of
// these read-only until it can do that: changing only the note's own status would leave the two out of step.
const recurrenceKeys = ['recurrence', 'recurrence_anchor', 'complete_instances', 'skipped_instances', 'recurrence_parent', 'occurrence_date',
  'occurrence_materialization', 'occurrence_next_trigger', 'occurrence_template', 'occurrence_past_horizon', 'occurrence_future_horizon',
  'recurrenceAnchor', 'completeInstances', 'skippedInstances', 'recurrenceParent', 'occurrenceDate',
  'occurrenceMaterialization', 'occurrenceNextTrigger', 'occurrenceTemplate', 'occurrencePastHorizon', 'occurrenceFutureHorizon'];
/** The value of a relation property, under the name in the settings, the usual name, or another spelling. */
function relationValue(values: Record<string, unknown>, names: RelationFieldNames, key: keyof RelationFieldNames): unknown {
  const name = [names[key], defaultRelationFieldNames[key], ...relationAliases[key]].find(n => Object.hasOwn(values, n));
  return name === undefined ? undefined : values[name];
}
const stringOrNull = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const PRIORITIES = new Set(['none', 'low', 'normal', 'high']);

/**
 * `statuses`, `fields` and `identification` come from the TaskNotes settings (see status-config.ts): the status list, the property
 * name each field is stored under, and how a note is known to be a task. A status outside the list is reported as unknown.
 */
export function parseTask(path: string, raw: string, statuses: readonly StatusOption[] = defaultStatuses, fields: FieldNames = defaultFieldNames, relationFields: RelationFieldNames = defaultRelationFieldNames, identification: TaskIdentification = defaultIdentification): TaskRecord {
  validatePath(path);
  const { values: v, body } = frontmatter(raw);
  // A task found by a property need not have tags at all.
  const untagged = v.tags === undefined || v.tags === null;
  if (!(untagged || typeof v.tags === 'string' || (Array.isArray(v.tags) && v.tags.every(t => typeof t === 'string')))) {
    throw new TaskDataError('INVALID_TAGS');
  }
  const tags = frontmatterTags(v.tags);
  if (!isTaskFrontmatter(v, identification)) throw new TaskDataError('NOT_A_TASK');
  const rawStatus = stringOrNull(v[fieldName(v, 'status', fields)]);
  const known = findStatus(rawStatus, statuses);
  const status: TaskState = known ? (known.completed ? 'done' : 'open') : 'unknown';
  const rawPriority = stringOrNull(v[fieldName(v, 'priority', fields)]);
  const p = rawPriority?.toLowerCase() ?? '';
  const priority = (PRIORITIES.has(p) ? p : 'unknown') as Priority;
  const warnings: string[] = [];
  for (const key of logicalFields) {
    const present = namesFor(key, fields).filter(k => Object.hasOwn(v, k));
    const comparable = (value: unknown) => key === 'status' && typeof value === 'string' ? statusKey(value) ?? value : value;
    if (present.length > 1 && present.some(k => comparable(v[k]) !== comparable(v[present[0]!]))) warnings.push('CONFLICTING_FIELDS:' + present.join('/'));
  }
  if (v.title != null && typeof v.title !== 'string') warnings.push('INVALID_TITLE');
  if (status === 'unknown') warnings.push('UNKNOWN_STATUS');
  if (priority === 'unknown') warnings.push('UNKNOWN_PRIORITY');
  const date = (key: string): string | null => {
    key = fieldName(v, key, fields);
    const value = stringOrNull(v[key]);
    if ((value !== null && dateKey(value) === null) || (v[key] != null && typeof v[key] !== 'string')) {
      warnings.push(`INVALID_DATE:${key}`);
    }
    return value;
  };
  const title = stringOrNull(v.title)?.trim() || null;
  const recurring = recurrenceKeys
    .some(key => v[key] !== undefined && v[key] !== null && v[key] !== '' &&
      (!Array.isArray(v[key]) || (v[key] as unknown[]).length > 0));
  if (recurring) warnings.push('RECURRENCE_NOT_IMPLEMENTED');
  return {
    id: Buffer.from(path).toString('base64url'), path, revision: revisionOf(raw),
    title: title ?? path.split('/').at(-1)!.slice(0, -3), titleSource: title ? 'title' : 'filename',
    status, rawStatus, priority, rawPriority,
    scheduled: date('scheduled'), due: date('due'), completed: date('completedDate'),
    tags: [...new Set(tags)], projects: readProjects(relationValue(v, relationFields, 'projects')), blockedBy: readBlockedBy(relationValue(v, relationFields, 'blockedBy')), body, recurring, warnings,
  };
}

export function selectToday(tasks: readonly TaskRecord[], now: Date, scope: TaskScope = 'all'): TaskList {
  const today = localDate(now);
  const result: TaskList = { date: today, timezone: timeZone(), today: [], overdue: [], completed: [] };
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id) || (scope === 'work' && !hasTag(task.tags, workTags)) ||
        (scope === 'personal' && !hasTag(task.tags, personalTags))) continue;
    seen.add(task.id);
    const scheduled = dateKey(task.scheduled), due = dateKey(task.due);
    const isToday = scheduled === today || due === today;
    if (task.status === 'done') {
      if (isToday || dateKey(task.completed) === today) result.completed.push(task);
    } else if (isToday) result.today.push(task);
    else if (due !== null && due < today) result.overdue.push(task);
  }
  const weights: Record<Priority, number> = { high: 0, normal: 1, low: 2, none: 3, unknown: 4 };
  for (const group of [result.today, result.overdue, result.completed]) {
    group.sort((a, b) => weights[a.priority] - weights[b.priority] ||
      a.title.localeCompare(b.title, 'ko') || a.path.localeCompare(b.path, 'ko'));
  }
  return result;
}

/** Pure M0 experiment: edits scalar tokens in memory; never writes a file. */
// A value of null writes `key: null`. A value of undefined removes the property, which is what TaskNotes does when a date is cleared
// or a task is reopened (it leaves no empty `completedDate` behind).
export function previewScalarPatch(raw: string, expectedRevision: string, patch: Record<string, string | null | undefined>, extraKeys: readonly string[] = []): string {
  if (revisionOf(raw) !== expectedRevision) throw new TaskDataError('REVISION_CONFLICT');
  const parsed = frontmatter(raw);
  const allowed = new Set(['title', ...logicalFields, ...Object.values(aliasFieldNames).flat(), ...extraKeys]);
  const edits: { start: number; end: number; replacement: string }[] = [];
  const additions: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key) || (value !== null && value !== undefined && (typeof value !== 'string' || /[\r\n]/.test(value)))) {
      throw new TaskDataError('UNSUPPORTED_PATCH');
    }
    if (value === undefined) {
      if (!Object.hasOwn(parsed.values, key)) continue;
      const pair = (parsed.document.contents as YAMLMap).items.find(p => isScalar(p.key) && p.key.value === key);
      const name = pair?.key, content = pair?.value;
      // Only a one-line top-level property can be taken out safely; anything else is left to its owner.
      if (!isScalar(name) || !name.range || !isScalar(content) || !content.range || content.anchor || /[\r\n]/.test(parsed.yaml.slice(name.range[0], content.range[1]))) throw new TaskDataError('UNSUPPORTED_PATCH');
      const lineStart = parsed.yaml.lastIndexOf('\n', name.range[0] - 1) + 1;
      if (parsed.yaml.slice(lineStart, name.range[0]).trim() !== '') throw new TaskDataError('UNSUPPORTED_PATCH');
      const lineEnd = parsed.yaml.indexOf('\n', content.range[1]);
      // On the last line there is no newline after it, so the line break before it goes instead.
      if (lineEnd >= 0) edits.push({ start: lineStart, end: lineEnd + 1, replacement: '' });
      else edits.push({ start: lineStart === 0 ? 0 : lineStart - (parsed.yaml[lineStart - 2] === '\r' ? 2 : 1), end: parsed.yaml.length, replacement: '' });
      continue;
    }
    if (parsed.values[key] === value) continue;
    const replacement = stringify(value, { lineWidth: 0 }).trimEnd();
    const node = parsed.document.get(key, true);
    if (node === undefined) { additions.push(`${key}: ${replacement}`); continue; }
    if (!isScalar(node) || !node.range || node.anchor ||
        /[\r\n]/.test(parsed.yaml.slice(node.range[0], node.range[1]))) {
      throw new TaskDataError('UNSUPPORTED_PATCH');
    }
    edits.push({ start: node.range[0], end: node.range[1], replacement });
  }
  let yaml = parsed.yaml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    yaml = yaml.slice(0, edit.start) + edit.replacement + yaml.slice(edit.end);
  }
  if (additions.length) {
    const eol = parsed.prefix.endsWith('\r\n') ? '\r\n' : '\n';
    yaml += eol + additions.join(eol);
  }
  const result = parsed.prefix + yaml + parsed.suffix + parsed.body;
  const after = frontmatter(result);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined ? Object.hasOwn(after.values, key) : after.values[key] !== value) throw new TaskDataError('PATCH_VERIFICATION_FAILED');
  }
  return result;
}

/** The two daily-note Bases use work-tag precedence and include missed scheduled days. */
export function matchesScope(task: TaskRecord, scope: TaskScope): boolean {
  return scope === 'all' || (scope === 'work' ? hasTag(task.tags, workTags) : !hasTag(task.tags, workTags));
}
export function selectDailyTasks(tasks: readonly TaskRecord[], now: Date, scope: TaskScope = 'all'): TaskList {
  const date = localDate(now);
  const eligible = tasks.filter(t => matchesScope(t, scope));
  const overdue = (t: TaskRecord) => isOverdue(t, date);
  const today = eligible.filter(t => t.status !== 'done' && [t.scheduled, t.due].some(d => { const key = dateKey(d); return key !== null && key <= date; }));
  today.sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || (dateKey(a.scheduled) ?? '').localeCompare(dateKey(b.scheduled) ?? '') || (dateKey(a.due) ?? '').localeCompare(dateKey(b.due) ?? '') || a.path.localeCompare(b.path, 'ko'));
  return { date, timezone: timeZone(), today, overdue: [], completed: eligible.filter(t => t.status === 'done' && dateKey(t.completed) === date) };
}
export function replaceTaskBody(raw: string, body: string): string {
  const parsed = frontmatter(raw);
  if (body && !/^[\r\n]/.test(body)) body = (parsed.prefix.endsWith('\r\n') ? '\r\n' : '\n') + body;
  return parsed.prefix + parsed.yaml + parsed.suffix + body;
}

/** Replace only classification tags; preserve other tags, YAML fields and the body. */
export function previewCategoryPatch(raw: string, expectedRevision: string, categories: readonly string[], target: string): string {
  if (revisionOf(raw) !== expectedRevision) throw new TaskDataError('REVISION_CONFLICT');
  if (!categories.includes(target) || categories.includes('task')) throw new TaskDataError('UNSUPPORTED_PATCH');
  const parsed = frontmatter(raw), original = parsed.document.get('tags', true);
  if ((!isScalar(original) && !isSeq(original)) || !original.range || original.anchor) throw new TaskDataError('UNSUPPORTED_PATCH');
  const items = isSeq(original) ? original.items : [original];
  if (items.some(n => !isScalar(n) || typeof n.value !== 'string' || n.anchor)) throw new TaskDataError('UNSUPPORTED_PATCH');
  const node = isSeq(original) ? original.clone() : parsed.document.createNode([original.value as string]);
  if (!isSeq(original)) { node.flow = true; if (original.comment !== undefined) node.comment = original.comment; }
  let replaced = false;
  node.items = items.flatMap(item => {
    const scalar = (item as Scalar<string>).clone() as Scalar<string>;
    if (!categories.includes(scalar.value.replace(/^#/, ''))) return [scalar];
    if (replaced) return [];
    replaced = true; scalar.value = target; return [scalar];
  });
  if (!replaced) node.add(new Scalar(target));
  const start = original.range[0], end = Math.min(original.range[2], parsed.yaml.length);
  const originalText = parsed.yaml.slice(start, end);
  const linePrefix = parsed.yaml.slice(parsed.yaml.lastIndexOf('\n', start - 1) + 1, start);
  const indent = /^ *$/.test(linePrefix) ? linePrefix : '';
  const eol = parsed.prefix.endsWith('\r\n') ? '\r\n' : '\n';
  const replacement = stringify(node, { lineWidth: 0 }).trimEnd().split('\n').join(eol + indent) + (/\n$/.test(originalText) ? eol : '');
  const result = parsed.prefix + parsed.yaml.slice(0, start) + replacement + parsed.yaml.slice(end) + parsed.suffix + parsed.body;
  const before = parseTask('task.md', raw), after = parseTask('task.md', result);
  const expected = [...before.tags.filter(tag => !categories.includes(tag)), target].sort();
  if (JSON.stringify([...after.tags].sort()) !== JSON.stringify([...new Set(expected)].sort())) throw new TaskDataError('PATCH_VERIFICATION_FAILED');
  return result;
}

/**
 * One change to a note's `projects` or `blockedBy` list: take out every entry whose link `remove` accepts, then put `add` at the end.
 * `add` is a link such as `[[Name]]`. The rest of the note is left as it was. A list that ends up empty is removed from the note
 * (a new `projects` is written the way TaskNotes writes it, a list of quoted links; a `blockedBy` entry gets `reltype: FINISHTOSTART`).
 * Returns the note unchanged when there is nothing to take out and nothing to add.
 */
export interface RelationPatch { kind: 'project' | 'blockedBy'; names: RelationFieldNames; remove: (link: string) => boolean; add: string | null }
export function previewRelationPatch(raw: string, expectedRevision: string, patch: RelationPatch): string {
  if (revisionOf(raw) !== expectedRevision) throw new TaskDataError('REVISION_CONFLICT');
  const parsed = frontmatter(raw);
  const key = patch.kind === 'project' ? 'projects' : 'blockedBy';
  // The name this note already uses (the one in the TaskNotes settings, the usual one, or another spelling), else the one in the settings.
  const name = [patch.names[key], defaultRelationFieldNames[key], ...relationAliases[key]].find(n => Object.hasOwn(parsed.values, n)) ?? patch.names[key];
  const linkOf = (value: unknown): string | null => (patch.kind === 'project' ? readProjects([value])[0] : readBlockedBy([value])[0]?.uid) ?? null;
  const eol = parsed.prefix.endsWith('\r\n') ? '\r\n' : '\n';
  const pair = (parsed.document.contents as YAMLMap).items.find(p => isScalar(p.key) && p.key.value === name);
  const original = pair?.value as unknown;
  const present = pair !== undefined;
  const isEmptyValue = present && isScalar(original) && (original.value === null || original.value === '');
  if (present && !isEmptyValue && !isSeq(original) && !(isScalar(original) && typeof original.value === 'string')) throw new TaskDataError('UNSUPPORTED_PATCH');
  if (present && ((isSeq(original) || isScalar(original)) && (original as { anchor?: string }).anchor)) throw new TaskDataError('UNSUPPORTED_PATCH');
  const nodes: unknown[] = isSeq(original) ? original.items : present && !isEmptyValue ? [original] : [];
  const values: unknown[] = isSeq(original) ? (parsed.values[name] as unknown[]) : present && !isEmptyValue ? [parsed.values[name]] : [];
  const kept: unknown[] = [];
  let removed = 0;
  nodes.forEach((node, index) => {
    const link = linkOf(values[index]);
    if (link !== null && patch.remove(link)) { removed++; return; }
    // A link written as an unquoted [[Name]] is read as a list inside a list; it goes back as the quoted text it stands for.
    if (link !== null && typeof values[index] !== 'string' && patch.kind === 'project') kept.push(new Scalar(link));
    else kept.push(isScalar(node) || isSeq(node) || isMap(node) ? node.clone() : node);
  });
  if (!removed && patch.add === null) return raw;
  const added = patch.add === null ? [] : [patch.kind === 'project' ? new Scalar(patch.add) : parsed.document.createNode({ uid: patch.add, reltype: 'FINISHTOSTART' })];
  const items = [...kept, ...added];
  const flow = isSeq(original) ? !!original.flow : isScalar(original) && !isEmptyValue;
  const seq = parsed.document.createNode([]) as ReturnType<typeof parsed.document.createNode> & { items: unknown[]; flow?: boolean };
  seq.items = items; seq.flow = flow;
  const text = stringify(seq, { lineWidth: 0 }).trimEnd();
  let yaml = parsed.yaml;
  if (!present) {
    yaml += eol + stringify({ [name]: items.map(item => (isScalar(item) ? (item as Scalar).value : (item as { toJSON(): unknown }).toJSON())) }, { lineWidth: 0 }).trimEnd().split('\n').join(eol);
  } else {
    const keyNode = pair!.key as Scalar, keyStart = keyNode.range![0], lineStart = yaml.lastIndexOf('\n', keyStart - 1) + 1;
    // Where the value stops on its last line, ignoring the line break after it.
    const valueNode = original as { range?: [number, number, number] | null };
    let valueEnd = isEmptyValue ? keyNode.range![1] : valueNode.range![1];
    while (!isEmptyValue && valueEnd > valueNode.range![0] && /[\r\n]/.test(yaml[valueEnd - 1]!)) valueEnd--;
    if (!items.length) {
      const nl = yaml.indexOf('\n', valueEnd);
      if (nl >= 0) yaml = yaml.slice(0, lineStart) + yaml.slice(nl + 1);
      else yaml = yaml.slice(0, lineStart === 0 ? 0 : lineStart - (yaml[lineStart - 2] === '\r' ? 2 : 1));
    } else if (isEmptyValue) {
      // `projects:` with nothing after it: the list goes on the lines below.
      let lineEnd = yaml.indexOf('\n', keyNode.range![1]);
      if (lineEnd > 0 && yaml[lineEnd - 1] === '\r') lineEnd--;
      const colon = yaml.indexOf(':', keyNode.range![1]) + 1;
      yaml = yaml.slice(0, colon) + (flow ? ' ' + text : eol + '  ' + text.split('\n').join(eol + '  ')) + (lineEnd >= 0 ? yaml.slice(lineEnd) : '');
    } else {
      const start = valueNode.range![0];
      const linePrefix = yaml.slice(yaml.lastIndexOf('\n', start - 1) + 1, start);
      const indent = /^ *$/.test(linePrefix) ? linePrefix : '';
      yaml = yaml.slice(0, start) + text.split('\n').join(eol + indent) + yaml.slice(valueEnd);
    }
  }
  const result = parsed.prefix + yaml + parsed.suffix + parsed.body;
  const after = frontmatter(result);
  const expected = [...kept.map(item => linkOf(isScalar(item) ? (item as Scalar).value : (item as { toJSON?(): unknown }).toJSON?.() ?? item)), ...(patch.add === null ? [] : [patch.add])];
  const written = after.values[name];
  const actual = (written == null || written === '' ? [] : Array.isArray(written) ? written : [written]).map(linkOf);
  const others = (values: Record<string, unknown>) => JSON.stringify(Object.entries(values).filter(([k]) => k !== name));
  if (JSON.stringify(actual) !== JSON.stringify(expected) || others(after.values) !== others(parsed.values) || (!items.length && Object.hasOwn(after.values, name))) throw new TaskDataError('PATCH_VERIFICATION_FAILED');
  return result;
}
