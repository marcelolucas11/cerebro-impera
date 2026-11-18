import type { AccessLevel, ItemScope, StageKind, UserStatus } from './api.js';

/* Names people read for the things the system stores as codes. One place, so they stay consistent. */

export const CAPABILITY_NAMES: Record<string, { name: string; detail: string }> = {
  'users.manage': {
    name: 'Gerenciar pessoas',
    detail: 'Convidar, suspender e dar acesso a quem está abaixo na hierarquia.',
  },
  'devices.approve': {
    name: 'Aprovar aparelhos',
    detail: 'Liberar ou recusar aparelhos novos de quem está abaixo na hierarquia.',
  },
  'audit.view': { name: 'Ver auditoria', detail: 'Consultar o registro de tudo o que foi feito.' },
  export: { name: 'Exportar dados', detail: 'Tirar dados do sistema em arquivo.' },
  bulk_delete: { name: 'Apagar em massa', detail: 'Apagar vários itens de uma vez.' },
  'automations.manage': {
    name: 'Gerenciar automações',
    detail: 'Criar e alterar regras automáticas.',
  },
  'secret_fields.reveal': {
    name: 'Revelar campos secretos',
    detail: 'Ver o conteúdo de campos protegidos.',
  },
  'system.config': { name: 'Configurar o sistema', detail: 'Alterar nome, marca e regras gerais.' },
};

export const LEVEL_NAMES: Record<AccessLevel, string> = {
  none: 'Sem acesso',
  view: 'Pode ver',
  comment: 'Pode comentar',
  edit: 'Pode editar',
  manage: 'Gerencia',
};

export const ITEM_SCOPE_NAMES: Record<ItemScope, string> = {
  assigned: 'Só os itens da pessoa',
  all: 'Todos os itens',
};

export const STATUS_NAMES: Record<UserStatus, string> = {
  invited: 'Convidado',
  active: 'Ativo',
  suspended: 'Suspenso',
};

export const ALERT_NAMES: Record<string, string> = {
  device_pending: 'Aparelho novo aguardando aprovação',
  device_approved: 'Aparelho aprovado por quem não é Dono',
  permission_changed: 'Permissão alterada por quem não é Dono',
  recovery_code_used: 'Código de recuperação usado para entrar',
  login_lockout: 'Conta bloqueada por excesso de tentativas',
  access_reset_issued: 'Novo link de acesso gerado',
  user_created: 'Pessoa convidada',
  owner_added: 'Novo Dono',
  owner_role_changed: 'Papel de um Dono alterado',
};

const ACTION_NAMES: Record<string, string> = {
  'instance.setup_completed': 'Instalação concluída',
  'instance_settings.update': 'Configurações do sistema alteradas',
  'login.succeeded': 'Entrou',
  'login.failed': 'Tentativa de entrada recusada',
  'session.step_up': 'Confirmou o segundo fator',
  'session.revoked': 'Saiu ou teve a sessão encerrada',
  'sessions.revoked_all': 'Todas as sessões de uma pessoa encerradas',
  'totp.enrolled': 'Autenticador cadastrado',
  'recovery_code.used': 'Código de recuperação usado',
  'invite.created': 'Link de acesso gerado',
  'invite.accepted': 'Link de acesso usado',
  'user.created': 'Pessoa convidada',
  'user.updated': 'Pessoa alterada',
  'device.pending': 'Aparelho novo pediu aprovação',
  'device.approved': 'Aparelho aprovado',
  'device.rejected': 'Aparelho recusado',
  'device.revoked': 'Aparelho revogado',
  'list.sensitive_viewed': 'Lista sensível aberta',
  'item.assignees_changed': 'Responsáveis de um item alterados',
  'list_stages.insert': 'Etapa criada em uma lista',
  'list_stages.update': 'Etapa de uma lista alterada',
  'list_stages.delete': 'Etapa removida de uma lista',
  'list_fields.insert': 'Campo criado em uma lista',
  'list_fields.update': 'Campo de uma lista alterado',
  'password.changed': 'Senha trocada pela própria pessoa',
  'items.purged': 'Itens removidos de vez da lixeira, depois de 30 dias',
  'access_grants.insert': 'Acesso concedido',
  'access_grants.update': 'Acesso alterado',
  'access_grants.delete': 'Acesso retirado',
  'user_capabilities.insert': 'Capacidade concedida',
  'user_capabilities.delete': 'Capacidade retirada',
};

/** A known action in plain words; an unknown one is shown as stored, never hidden. */
export function actionName(action: string): string {
  return ACTION_NAMES[action] ?? action;
}

const when = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : when.format(date);
}

/** How long something has lasted, in the largest unit that fits: people compare days, not seconds. */
export function formatDuration(milliseconds: number): string {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return 'menos de 1 minuto';
  if (minutes < 60) return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hora' : `${hours} horas`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 dia' : `${days} dias`;
}

export const STAGE_KIND_NAMES: Record<StageKind, string> = {
  open: 'Ainda não começou',
  active: 'Em andamento',
  done: 'Concluído',
  closed: 'Encerrado sem concluir',
};

export function lastUsed(iso: string | null): string {
  return iso === null
    ? 'ainda não usado desde a aprovação'
    : `usado pela última vez em ${formatWhen(iso)}`;
}

/** "Chrome no Windows" from a browser's identification string; the raw string when unsure. */
export function describeDevice(userAgent: string): string {
  const system = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(userAgent)
            ? 'Mac'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : null;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  if (system === null || browser === null)
    return userAgent.slice(0, 80) || 'Aparelho não identificado';
  return `${browser} no ${system}`;
}
