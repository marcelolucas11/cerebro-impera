/** What a stage means for totals and reports, whatever it is called. */
export const STAGE_KINDS = ['open', 'active', 'done', 'closed'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export interface StageDraft {
  name: string;
  color: string;
  kind: StageKind;
}

/** What a new list starts with when nobody chose its stages. */
export const DEFAULT_STAGES: readonly StageDraft[] = [
  { name: 'A fazer', color: '#9ba6b8', kind: 'open' },
  { name: 'Fazendo', color: '#dba63f', kind: 'active' },
  { name: 'Feito', color: '#58b98a', kind: 'done' },
];

export const MAX_STAGES_PER_LIST = 40;
