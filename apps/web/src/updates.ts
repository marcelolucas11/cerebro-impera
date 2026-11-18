/* Updates in words: each step of an update, and each reason the updater gives for refusing one. */

export const STEP_NAMES: Record<string, string> = {
  backup: 'Copiando o banco de dados',
  verify: 'Conferindo a assinatura da versão',
  download: 'Baixando a versão nova',
  migrate: 'Atualizando o banco de dados',
  start: 'Subindo a versão nova',
  health: 'Conferindo se a versão nova respondeu bem',
  rollback: 'Voltando para a versão anterior',
};

export const STEP_ORDER = ['backup', 'verify', 'download', 'migrate', 'start', 'health'] as const;

const REFUSALS: Record<string, string> = {
  not_available: 'essa versão não está mais disponível. Procure de novo.',
  not_newer: 'essa versão não é mais nova do que a que está em uso.',
  signature_invalid:
    'a assinatura da versão não confere com o repositório do projeto. Nada foi instalado.',
  manifest_missing: 'a versão não traz o arquivo assinado que o atualizador exige.',
  busy: 'já há uma atualização em andamento.',
};

export function refusalText(code: string): string {
  return `O atualizador recusou: ${REFUSALS[code] ?? 'motivo não reconhecido. Nada foi instalado.'}`;
}

/** Where a step sits among all of them: done, now, or still to come. */
export function stepState(step: string, current: string): 'done' | 'now' | 'next' {
  const at = STEP_ORDER.indexOf(current as (typeof STEP_ORDER)[number]);
  const here = STEP_ORDER.indexOf(step as (typeof STEP_ORDER)[number]);
  if (at === -1) return 'next';
  return here < at ? 'done' : here === at ? 'now' : 'next';
}
