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

/**
 * Ready-made sets anyone can start a list from. Deliberately generic: a team's
 * own sets are kept as files and imported, never written here.
 */
export const STAGE_PRESETS: readonly { name: string; stages: readonly StageDraft[] }[] = [
  { name: 'Tarefas', stages: DEFAULT_STAGES },
  {
    name: 'Tarefas com revisão',
    stages: [
      { name: 'A fazer', color: '#9ba6b8', kind: 'open' },
      { name: 'Fazendo', color: '#dba63f', kind: 'active' },
      { name: 'Em revisão', color: '#8fb8ff', kind: 'active' },
      { name: 'Feito', color: '#58b98a', kind: 'done' },
      { name: 'Cancelado', color: '#ef7b6a', kind: 'closed' },
    ],
  },
  {
    name: 'Clientes',
    stages: [
      { name: 'Contato', color: '#9ba6b8', kind: 'open' },
      { name: 'Em negociação', color: '#8fb8ff', kind: 'open' },
      { name: 'Ativo', color: '#58b98a', kind: 'active' },
      { name: 'Pausado', color: '#dba63f', kind: 'active' },
      { name: 'Encerrado', color: '#ef7b6a', kind: 'closed' },
    ],
  },
  {
    name: 'Aprovação',
    stages: [
      { name: 'Rascunho', color: '#9ba6b8', kind: 'open' },
      { name: 'Aguardando aprovação', color: '#dba63f', kind: 'active' },
      { name: 'Aprovado', color: '#58b98a', kind: 'done' },
      { name: 'Recusado', color: '#ef7b6a', kind: 'closed' },
    ],
  },
];

/** What an exported set of stages says it is, so an import knows what it reads. */
export const STAGE_FILE_KIND = 'cerebro.stages';
export const STAGE_FILE_VERSION = 1;
