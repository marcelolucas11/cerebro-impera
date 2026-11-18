import type { PasswordProblem } from '@cerebro/shared';
import { ApiError, type Role } from './api.js';
import { describeFieldProblem } from './fieldvalues.js';
import { formatBytes } from './labels.js';

/*
 * Every sentence a person reads when something does not go through. Each one
 * says what happened and what to do next. Kept in one place so the wording
 * stays consistent and can be translated later.
 */

export const PASSWORD_PROBLEMS: Record<PasswordProblem, string> = {
  too_short: 'Use pelo menos 12 caracteres. Uma frase com várias palavras funciona bem.',
  too_long: 'Use no máximo 128 caracteres.',
  low_variety: 'Use mais caracteres diferentes entre si.',
  too_common: 'Essa senha aparece em listas de senhas vazadas. Escolha outra.',
  contains_identity: 'Não use seu nome nem seu e-mail dentro da senha.',
};

export const ROLE_NAMES: Record<Role, string> = {
  owner: 'Dono',
  admin: 'ADM',
  manager: 'Gestor',
  employee: 'Funcionário',
};

function wait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} segundos`;
  return `${Math.round(seconds / 60)} minutos`;
}

const BY_CODE: Record<string, string> = {
  network: 'Não foi possível falar com o servidor. Confira sua conexão e tente de novo.',
  invalid_credentials: 'E-mail ou senha incorretos.',
  invalid_code:
    'Código incorreto ou já usado. Espere o aplicativo mostrar um código novo e digite de novo.',
  challenge_required: 'A etapa da senha expirou. Entre de novo.',
  unauthorized: 'Sua sessão terminou. Entre de novo.',
  rule_violation: 'Isso deixaria o sistema sem nenhum Dono ativo, então não é permitido.',
  conflict: 'Já existe um registro assim.',
  already_exists: 'Já existe uma com esse nome.',
  stage_in_use: 'Ainda há itens nesta etapa. Escolha para onde eles vão antes de removê-la.',
  invalid_stage: 'Essa etapa não pertence a esta lista.',
  too_many_stages: 'Esta lista já tem o máximo de etapas.',
  too_many_fields: 'Esta lista já tem o máximo de campos. Arquive um para criar outro.',
  invalid_field: 'Esse campo não pertence a esta lista, ou foi arquivado.',
  invalid_option: 'Uma das opções não pertence a este campo. Recarregue a página e tente de novo.',
  option_cannot_be_removed:
    'Opções não são apagadas, só arquivadas: assim os itens que já a usam continuam certos.',
  rating_scale_is_fixed: 'A escala de uma nota não muda depois de criada. Crie outro campo.',
  invalid_list: 'Escolha outra lista.',
  not_in_trash: 'Este item já saiu da lixeira.',
  same_list: 'O item já está nesta lista.',
  too_many_checks: 'A checklist já tem 100 linhas, o máximo por item.',
  comment_removed: 'Este comentário foi apagado e não muda mais.',
  invalid_parent:
    'A subtarefa precisa ficar debaixo de um item desta lista que não seja subtarefa.',
  dates_out_of_order: 'O prazo não pode vir antes do começo.',
  stage_restricted:
    'Essa etapa só recebe itens de pessoas com um papel acima do seu. Peça a quem gerencia a lista.',
  unknown_stage: 'Uma das etapas da regra não é desta lista. Recarregue a página e confira.',
  unknown_field: 'Um dos campos da regra não é desta lista, foi arquivado ou não tem essa opção.',
  unknown_person: 'Uma das pessoas da regra não existe mais.',
  cannot_notify_person: 'Uma das pessoas a avisar não vê esta lista.',
  invalid_value: 'O valor de um campo da regra não cabe nele. Confira as opções e o formato.',
  too_many_automations: 'Esta lista já tem 50 regras, o máximo. Apague uma para criar outra.',
  sensitive_list: 'Listas sensíveis não têm regras: nelas, tudo é feito por uma pessoa.',
  bad_trigger: 'A regra precisa dizer quando age.',
  bad_conditions: 'Uma das condições da regra está incompleta.',
  bad_actions: 'A regra precisa de uma a cinco ações completas.',
  same_password: 'A nova senha precisa ser diferente da atual.',
  cannot_assign_person:
    'Essa pessoa não pode trabalhar nesta lista. Dê a ela acesso para editar antes de passar o item.',
  attachments_not_ready:
    'Os anexos ainda não foram ligados nesta instalação: falta escolher o antivírus no servidor.',
  disk_full:
    'O servidor está sem espaço para guardar esse arquivo. Avise quem administra o sistema.',
  invalid_part: 'O envio se perdeu no caminho. Tente continuar de novo.',
  invalid_part_size: 'O envio se perdeu no caminho. Tente continuar de novo.',
  parts_missing: 'Ainda faltam partes do arquivo. Tente continuar o envio.',
  upload_finished: 'Esse envio já terminou.',
  upload_unfinished: 'Esse envio ainda não terminou. Termine ou descarte antes.',
  attachment_scanning:
    'O antivírus ainda está conferindo este arquivo. Tente de novo em instantes.',
  attachment_blocked: 'O antivírus bloqueou este arquivo. Ninguém pode baixá-lo.',
  not_same_file: 'Esse não é o mesmo arquivo do envio interrompido. Escolha o arquivo original.',
  view_name_taken: 'Você já tem uma visão com esse nome nesta lista.',
  too_many_views: 'Você já tem 30 visões nesta lista. Apague uma para salvar outra.',
  invalid_order: 'A ordem mudou enquanto você arrastava. Recarregue e tente de novo.',
  invalid_selection:
    'Algum item selecionado não pode ser mudado por você, ou já saiu da lista. Nada foi mudado.',
  setup_closed:
    'Token de instalação incorreto, ou a instalação já foi concluída. O token está no arquivo setup-token do servidor.',
  invalid_invite: 'Este convite não vale mais. Peça um novo a quem administra o sistema.',
  totp_not_pending: 'O cadastro do autenticador expirou. Entre de novo para recomeçar.',
  totp_already_enrolled: 'Esta conta já tem um autenticador. Entre com o código dele.',
  account_suspended: 'Esta conta está suspensa. Fale com quem administra o sistema.',
  invalid_input: 'Confira os campos e tente de novo.',
  bad_origin: 'Abra o sistema pelo endereço oficial e tente de novo.',
  step_up_required: 'Confirme o código do autenticador para continuar.',
  forbidden: 'Você não tem permissão para isso.',
  not_found: 'Não encontrado, ou você não tem acesso.',
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'too_many_attempts') {
      const seconds = error.details.retryAfterSeconds;
      return `Muitas tentativas. Tente de novo em ${wait(typeof seconds === 'number' ? seconds : 60)}.`;
    }
    if (error.code === 'too_many_requests') {
      const seconds = error.details.retryAfterSeconds;
      return `Muitas ações em pouco tempo. Espere ${wait(typeof seconds === 'number' ? seconds : 60)} e tente de novo.`;
    }
    if (error.code === 'weak_password') {
      const problems = Array.isArray(error.details.problems) ? error.details.problems : [];
      const first = problems.find(
        (p): p is PasswordProblem => typeof p === 'string' && p in PASSWORD_PROBLEMS,
      );
      return first ? PASSWORD_PROBLEMS[first] : 'Escolha uma senha mais forte.';
    }
    if (error.code === 'invalid_field_value') return describeFieldProblem(error.details.problem);
    if (error.code === 'file_too_large') {
      const limit = error.details.maxBytes;
      return typeof limit === 'number'
        ? `O arquivo passa do limite desta instalação, que é de ${formatBytes(limit)}.`
        : 'O arquivo passa do limite desta instalação.';
    }
    const known = BY_CODE[error.code];
    if (known !== undefined) return known;
  }
  return 'O servidor não conseguiu concluir o pedido. Tente de novo em instantes.';
}
