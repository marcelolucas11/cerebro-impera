# Cérebro

Sistema de gestão de código aberto e white label, no estilo dos gerenciadores de tarefas por
espaços, pastas e listas, feito para empresas que precisam **compartilhar informação interna sem
perder o controle de quem vê o quê**.

> **Estado: em construção.** A fundação de segurança (Fase 1, backend) está implementada e testada.
> Ainda não há interface nem pacote de instalação. **Não use em produção.** O andamento está em
> [`docs/PROGRESS.md`](docs/PROGRESS.md).

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

| Área                                                                                          | Situação       |
| --------------------------------------------------------------------------------------------- | -------------- |
| Assistente de primeira instalação (token gerado no servidor, primeiro Dono com 2FA)           | feito          |
| Login com senha (argon2id) + segundo fator obrigatório (TOTP), códigos de recuperação         | feito          |
| Aprovação de dispositivo novo por quem tem autoridade; revogação imediata                     | feito          |
| Sessões no servidor, expiração por inatividade, confirmação do 2º fator para ações críticas   | feito          |
| Bloqueio progressivo contra força bruta                                                       | feito          |
| Papéis, capacidades e concessões por espaço / pasta / lista, com herança                      | feito          |
| Listas sensíveis (exigem 2º fator recente; cada abertura é registrada)                        | feito          |
| Trilha de auditoria imutável + alertas de segurança para os Donos                             | feito          |
| Etapas, campos personalizados, visões, tarefas, automações, painéis, PWA, atualizador, backup | próximas fases |

## Estrutura

```
apps/api            API (Node 22, Fastify, PostgreSQL)
  migrations/       esquema, funções de autorização, gatilhos e políticas de RLS
  test/             testes, incluindo ataques diretos ao banco com as credenciais da API
packages/shared     tipos, validação de entrada e regras de acesso compartilhadas
docs/               andamento e decisões
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
