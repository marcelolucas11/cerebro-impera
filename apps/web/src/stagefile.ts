import {
  STAGE_FILE_KIND,
  STAGE_FILE_VERSION,
  stageFileSchema,
  type StageDraft,
} from '@cerebro/shared';

/*
 * Sets of stages saved as files: what an export writes and what an import
 * accepts. A file is read as untrusted text: nothing in it runs, and anything
 * that is not exactly a set of stages is refused with a sentence.
 */

export interface StageFile {
  kind: typeof STAGE_FILE_KIND;
  version: typeof STAGE_FILE_VERSION;
  name: string;
  stages: StageDraft[];
}

export function stageFileOf(name: string, stages: readonly StageDraft[]): StageFile {
  return {
    kind: STAGE_FILE_KIND,
    version: STAGE_FILE_VERSION,
    name,
    stages: stages.map(({ name: stageName, color, kind }) => ({ name: stageName, color, kind })),
  };
}

/** A file name people recognise: "etapas-clientes-ativos.json". */
export function stageFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `etapas-${slug === '' ? 'lista' : slug}.json`;
}

/** Larger than any real set of stages; anything bigger is not one. */
const MAX_FILE_BYTES = 64 * 1024;

export type ReadStageFile = { ok: true; file: StageFile } | { ok: false; message: string };

export function readStageFile(text: string): ReadStageFile {
  if (text.length > MAX_FILE_BYTES) {
    return { ok: false, message: 'Este arquivo é grande demais para ser um conjunto de etapas.' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Este arquivo não é um conjunto de etapas exportado do sistema.' };
  }
  if (
    typeof data === 'object' &&
    data !== null &&
    'kind' in data &&
    data.kind !== STAGE_FILE_KIND
  ) {
    return { ok: false, message: 'Este arquivo não é um conjunto de etapas exportado do sistema.' };
  }
  if (typeof data === 'object' && data !== null && 'version' in data) {
    if (data.version !== STAGE_FILE_VERSION) {
      return {
        ok: false,
        message: 'Este arquivo é de outra versão do sistema e não pode ser lido.',
      };
    }
  }
  const parsed = stageFileSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        'O arquivo tem algo fora do esperado: confira se cada etapa tem nome, cor e significado, sem nomes repetidos, e no máximo 40 etapas.',
    };
  }
  return { ok: true, file: parsed.data };
}

/** Hands a file to the person's browser to save, without leaving the page. */
export function download(fileName: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before letting go of it.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}
