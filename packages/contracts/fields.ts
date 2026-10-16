/**
 * The property names a note stores its values under. TaskNotes lets you rename them (its "field mapping" setting), so the
 * app follows that setting. The fields are named here by the key TaskNotes' own settings use for them.
 */
export const logicalFields = ['status', 'priority', 'scheduled', 'due', 'completedDate', 'dateModified'] as const;
export type LogicalField = (typeof logicalFields)[number];
/** For each field, the property name this vault uses. */
export type FieldNames = Record<LogicalField, string>;

/** TaskNotes' own property names: what a vault without a field-mapping setting uses. */
export const defaultFieldNames: Readonly<FieldNames> = { status: 'status', priority: 'priority', scheduled: 'scheduled', due: 'due', completedDate: 'completedDate', dateModified: 'dateModified' };

/** The Korean names many Korean setups give the same properties. */
export const koreanFieldNames: Readonly<FieldNames> = { status: '상태', priority: '우선순위', scheduled: '예정일', due: '마감일', completedDate: '완료일', dateModified: '수정일' };

/**
 * Other names the same properties go by in notes: older English spellings and the Korean names. They are always read. They are
 * written only into a note that already uses them (see fieldName in tasknotes/task.ts).
 */
export const aliasFieldNames: Readonly<Record<LogicalField, readonly string[]>> = {
  status: [koreanFieldNames.status], priority: [koreanFieldNames.priority], scheduled: [koreanFieldNames.scheduled], due: [koreanFieldNames.due],
  completedDate: ['completed', koreanFieldNames.completedDate], dateModified: ['modified', koreanFieldNames.dateModified],
};

const maxNameLength = 64, reserved = new Set(['tags', 'title']);

/** A name that is safe to write as a plain property key in a note's frontmatter. */
export function validFieldName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= maxNameLength && /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u.test(value) && value === value.trim() && !reserved.has(value.toLowerCase());
}

/**
 * Reads the property names from TaskNotes' settings (its parsed data.json). The settings belong to another plugin, so a name
 * that is missing or not safe keeps its usual value. If two fields would end up with the same name, none of the settings are
 * used, because the notes could no longer tell those fields apart.
 */
export function parseFieldMapping(data: unknown): FieldNames {
  const mapping = data && typeof data === 'object' ? (data as { fieldMapping?: unknown }).fieldMapping : undefined;
  if (!mapping || typeof mapping !== 'object') return { ...defaultFieldNames };
  const names = { ...defaultFieldNames };
  for (const field of logicalFields) {
    const value = (mapping as Record<string, unknown>)[field];
    // Not a name another field already answers to (its usual name, or another spelling of it).
    const belongsToOther = logicalFields.some(other => other !== field && (defaultFieldNames[other] === value || aliasFieldNames[other].includes(value as string)));
    if (validFieldName(value) && !belongsToOther) names[field] = value;
  }
  return new Set(Object.values(names)).size === logicalFields.length ? names : { ...defaultFieldNames };
}

/** The properties that link a task to other notes. TaskNotes calls them `projects` and `blockedBy`, and lets you rename them. */
export interface RelationFieldNames { projects: string; blockedBy: string }
export const defaultRelationFieldNames: Readonly<RelationFieldNames> = { projects: 'projects', blockedBy: 'blockedBy' };
/** Other spellings a note may use (the spec lists blocked_by next to blockedBy). */
export const relationAliases: Readonly<Record<keyof RelationFieldNames, readonly string[]>> = { projects: [], blockedBy: ['blocked_by'] };

/** Reads the names from the TaskNotes settings; a name that is missing or not safe to use keeps its usual value. */
export function parseRelationFields(data: unknown): RelationFieldNames {
  const mapping = data && typeof data === 'object' ? (data as { fieldMapping?: unknown }).fieldMapping : undefined;
  const names = { ...defaultRelationFieldNames };
  if (!mapping || typeof mapping !== 'object') return names;
  for (const key of ['projects', 'blockedBy'] as const) {
    const value = (mapping as Record<string, unknown>)[key];
    if (validFieldName(value)) names[key] = value;
  }
  return names.projects === names.blockedBy ? { ...defaultRelationFieldNames } : names;
}
