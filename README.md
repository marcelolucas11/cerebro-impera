# Cérebro

Sistema de gestão de código aberto e white label, no estilo dos gerenciadores de tarefas por
espaços, pastas e listas, feito para empresas que precisam **compartilhar informação interna sem
perder o controle de quem vê o quê**.

> **Estado: em construção, ainda sem versão publicada.** As funções estão prontas no código e
> testadas (veja a tabela abaixo); falta a revisão independente de segurança (Fase 11) antes do
> uso em produção. O andamento está em [`docs/PROGRESS.md`](docs/PROGRESS.md). Para instalar numa
> empresa: [`docs/INSTALL.md`](docs/INSTALL.md).

## Princípios

- **O código é público; a segurança não depende de segredo no código.** Quem leu cada linha deste
  repositório ainda não consegue entrar em nenhuma instalação.
- **Nada de uma instalação vive aqui.** Domínio, marca, chaves e senhas são gerados no servidor de
  cada empresa, na primeira inicialização. Não existe senha nem chave padrão.
- **Toda regra de acesso existe em duas camadas independentes:** na API e no PostgreSQL
  (row-level security, gatilhos de guarda). Um erro em uma delas não vaza dado.
- **Hierarquia de comando:** Dono › ADM › Gestor › Funcionário. O papel sozinho não abre nenhum
  dado: o acesso é concedido por pessoa, por espaço, pasta ou lista. Funcionário vê só o que é dele.
- **Ninguém concede o que não tem**, e toda mudança de permissão fica numa trilha de auditoria
  que não pode ser editada nem apagada (encadeada por hash, para denunciar adulteração).

O porquê de cada escolha está em [`docs/DECISIONS.md`](docs/DECISIONS.md).

## O que já existe

| Área                                                                                       | Situação |
| ------------------------------------------------------------------------------------------ | -------- |
| Assistente de primeira instalação (token gerado no servidor, primeiro Dono com 2FA, marca) | feito    |
| Login com senha (argon2id) + segundo fator obrigatório (TOTP), códigos de recuperação      | feito    |
| Aprovação de dispositivo novo por quem tem autoridade; revogação imediata                  | feito    |
| Papéis, capacidades e concessões por espaço / pasta / lista, com herança; listas sensíveis | feito    |
| Trilha de auditoria imutável + alertas de segurança para os Donos                          | feito    |
| Etapas, campos personalizados (inclusive secretos e arquivos), histórico, lixeira, anexos  | feito    |
| Lista, quadro, calendário, tabela, linha do tempo, filtros, visões salvas, busca           | feito    |
| Subtarefas, checklist, comentários, menções, recorrência, avisos, tempo real               | feito    |
| Automações por lista, painel da lista, página inicial de cada pessoa, relatório semanal    | feito    |
| Aplicativo instalável (PWA), leitura e mudanças sem conexão, cifradas no aparelho          | feito    |
| Atualização pelo aplicativo, só de versões assinadas, com cópia antes e volta automática   | feito    |
| Cópias diárias cifradas (Google Drive), teste de restauração mensal, alertas               | feito    |
| White label (nome, cor, logo) e formulários públicos num endereço que só envia             | feito    |
| Revisão independente de segurança, implantação                                             | a fazer  |

## Estrutura

```
apps/api            API (Node 22, Fastify, PostgreSQL) e o serviço dos formulários públicos
  migrations/       esquema, funções de autorização, gatilhos e políticas de RLS
  test/             testes, incluindo ataques diretos ao banco com as credenciais da API
apps/web            a página (React), instalável, com o percurso em navegador real (e2e/)
apps/updater        o atualizador, que só instala versões assinadas
apps/backup         as cópias de segurança e o teste de restauração
packages/shared     tipos, validação de entrada e regras compartilhadas
infra/              compose.yaml de uma instalação
docs/               instalação, restauração, andamento, decisões e desenhos
```

## Desenvolvimento

Requisitos: Node 22, pnpm 10 e um PostgreSQL 16+ **descartável** (os testes de segurança exercitam
papéis, gatilhos e row-level security de verdade, então não há banco simulado).

```sh
pnpm install --frozen-lockfile
export TEST_PG_ADMIN_URL='postgres://postgres:<senha>@127.0.0.1:5432/postgres'
pnpm check        # lint, formatação, tipos e todos os testes
pnpm e2e          # percurso completo num navegador real (antes: pnpm --filter @cerebro/web exec playwright install chromium)
```

Antes do primeiro commit, ative a trava contra segredos:

```sh
git config core.hooksPath .githooks
```

Regras para contribuir estão em [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Segurança

Encontrou uma falha? **Não abra uma issue pública.** Veja [`SECURITY.md`](SECURITY.md).

## Licença

[AGPL-3.0-only](LICENSE). Você pode usar, estudar e modificar; quem oferecer o sistema como serviço
precisa manter o código das suas modificações aberto.
