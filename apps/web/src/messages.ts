import type { PasswordProblem } from '@cerebro/shared';
import { ApiError, type Role } from './api.js';

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
    if (error.code === 'weak_password') {
      const problems = Array.isArray(error.details.problems) ? error.details.problems : [];
      const first = problems.find(
        (p): p is PasswordProblem => typeof p === 'string' && p in PASSWORD_PROBLEMS,
      );
      return first ? PASSWORD_PROBLEMS[first] : 'Escolha uma senha mais forte.';
    }
    const known = BY_CODE[error.code];
    if (known !== undefined) return known;
  }
  return 'O servidor não conseguiu concluir o pedido. Tente de novo em instantes.';
}
