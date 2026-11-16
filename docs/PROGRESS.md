# Andamento

> Arquivo público. Não registra nada de nenhuma instalação: nem domínio, nem servidor, nem nomes.
> Quem retoma o trabalho lê este arquivo e [`DECISIONS.md`](DECISIONS.md) antes de qualquer coisa.

## Onde estamos

**Fase 1 — Fundação e segurança.** Backend, infraestrutura de execução, telas de entrada e telas
de administração concluídos, com o percurso em navegador real rodando no CI. Restam pequenos
itens listados em "Próximo passo".

| Fase                                                          | Situação                                    |
| ------------------------------------------------------------- | ------------------------------------------- |
| 0. Preparação do repositório (proteções no GitHub)            | depende do mantenedor, ver "Pendências"     |
| **1. Fundação e segurança**                                   | **pronta, salvo os restos listados abaixo** |
| 2. Estrutura (etapas, campos personalizados, anexos, lixeira) | a fazer                                     |
| 3. Visões (lista, quadro, calendário, tabela, linha do tempo) | a fazer                                     |
| 4. Tarefas e colaboração                                      | a fazer                                     |
| 5. Automações                                                 | a fazer                                     |
| 6. Painéis e relatórios                                       | a fazer                                     |
| 7. PWA e offline                                              | a fazer                                     |
| 8. Atualizador assinado                                       | a fazer                                     |
| 9. Backup e restauração                                       | a fazer                                     |
| 10. White label, assistente visual e formulários              | a fazer                                     |
| 11. Blindagem (revisão independente)                          | a fazer                                     |
| 12. Implantação                                               | só com autorização do mantenedor            |
| 13. Migração de dados                                         | só com autorização do mantenedor            |

## Feito na Fase 1

- Monorepo pnpm + TypeScript estrito; lint com regras de tipo; formatação.
- Banco (`apps/api/migrations/0001`–`0007`): papéis `cerebro_app` e `cerebro_auth`, contexto de
  requisição amarrado no banco, funções de autorização, gatilhos de guarda, RLS em todas as
  tabelas, trilha de auditoria encadeada por hash, alertas de segurança.
- API (`apps/api/src`): assistente de primeira instalação, login em duas etapas, TOTP de uso único,
  códigos de recuperação, convites e redefinição de acesso, aprovação e revogação de dispositivos,
  sessões, confirmação do segundo fator, bloqueio progressivo, pessoas, capacidades, concessões,
  estrutura mínima (espaço, pasta, lista, item, responsáveis), auditoria e alertas.
- Segredos da instância gerados no servidor (`init-secrets`); migrador com checksum.
- Repositório: CI (segredos, lint, tipos, testes, dependências), CodeQL, Scorecard, Dependabot,
  CODEOWNERS, trava de pre-commit, `SECURITY.md`, `CONTRIBUTING.md`.
- Infraestrutura (`apps/api/Dockerfile`, `infra/compose.yaml`): imagem sem root com código somente
  leitura; banco em rede interna; API publicada só em `127.0.0.1`; segredos gerados no primeiro
  start. O job "Imagem e Compose" do CI constrói a imagem, sobe uma instalação do zero e confere
  essas garantias a cada pull request.

- Interface (`apps/web`, React + Vite), servida pela própria API com CSP estrita: assistente de
  instalação, entrada com senha e 2º fator, cadastro do autenticador com QR code, códigos de
  recuperação, aceite de convite, espera de aprovação de dispositivo e uma tela inicial que lista
  as áreas acessíveis.

- Administração na interface: pessoas (convidar, papel, suspender, redefinir acesso, encerrar
  sessões), capacidades, concessões por espaço/pasta/lista, aparelhos (aprovar, recusar, revogar),
  alertas, registro de auditoria com verificação de integridade, criação de espaços, pastas e
  listas pelo Dono, e um diálogo único de "confirme que é você" que repete a ação depois do código.

### O que os testes provam (114 testes)

| Arquivo                                    | O que garante                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/test/access.test.ts` (12) | resolução de acesso e regra "ninguém concede o que não tem"                                                                                                                                                                                                                                                            |
| `apps/api/test/auth.test.ts` (22)          | instalação fechada sem o token; 2º fator obrigatório; código de uso único; dispositivo novo sem sessão até aprovação; convite de uso único; força bruta bloqueada; sessão revogada ou conta suspensa cai na hora; origem cruzada e subdomínio irmão recusados                                                          |
| `apps/api/test/authorization.test.ts` (19) | pela API: funcionário A não vê nem altera nada do B; ADM sem concessão não vê nada; ADM não concede fora da própria área nem para iguais ou superiores; ninguém se promove; lista sensível exige 2º fator; o último Dono não pode ser rebaixado                                                                        |
| `apps/api/test/database.test.ts` (23)      | direto no banco, com as credenciais da API e sem código da API: as mesmas garantias; identidade não pode ser forjada nem sobrevive à transação; credenciais inalcançáveis; auditoria não pode ser editada nem apagada; adulteração com acesso total é detectada; toda tabela tem RLS; nenhuma função aberta a `PUBLIC` |
| `apps/api/test/crypto.test.ts` (16)        | argon2id com sal novo; cifra autenticada presa à linha e à finalidade; resumo com chave para códigos de recuperação; tokens de 256 bits; TOTP sem repetição; segredos com permissão `0600` e nunca sobrescritos                                                                                                        |

| `apps/api/test/web.test.ts` (9) | a página vem com a política que proíbe código embutido e de outras origens; nenhum arquivo de fora da pasta, oculto ou de tipo desconhecido é servido; endereços da API nunca respondem com a página; a API continua recusando outras origens |
| `apps/web/test/*.test.ts` (13) | a página compilada só carrega arquivos próprios, sem nada embutido; mensagens de erro nunca mostram detalhe técnico |

**Percurso em navegador real** (`apps/web/e2e`, 10 passos, job "Percurso em navegador real" no CI):
um Dono no computador e uma funcionária no celular, contra uma instalação criada do zero pelos
mesmos comandos de produção. Instalação recusada sem o token do servidor; senha fraca explicada na
hora; mesma resposta para senha errada e e-mail inexistente; só a senha não abre nada; convite
aceito no celular e recusado na segunda vez; aparelho novo sem nenhum acesso até a aprovação;
aprovação que exige o 2º fator de novo; funcionária sem nenhum dado nem tela de administração;
uma lista liberada e só ela visível; registro de auditoria íntegro; suspensão que derruba a sessão
na hora; e nenhuma violação da política de segurança da página do começo ao fim. (Esse percurso já
pegou um defeito real: a tela de pessoas mostrava situação desatualizada; corrigido.)

Os testes do banco foram conferidos por mutação: enfraquecer de propósito uma regra (identidade
que sobrevive à transação, funcionário vendo a lista inteira, concessão sem gerenciar o escopo) faz
testes falharem; as regras restauradas voltam a passar.

### Como rodar

```sh
pnpm install --frozen-lockfile
export TEST_PG_ADMIN_URL='postgres://postgres:<senha>@127.0.0.1:5432/postgres'   # PostgreSQL 16+ descartável
pnpm check
```

## Ainda não verificado

- Os workflows rodaram e passaram na `main` (CI, CodeQL, Scorecard). O passo "Revisão das
  dependências novas do PR" reprova enquanto o "Dependency graph" estiver desligado nas
  configurações do repositório (ver "Pendências").
- As imagens base ainda são referenciadas por tag, não por digest. Fixar no pipeline de release
  (Fase 8).
- `pnpm audit` aponta 1 aviso de severidade moderada (`minimatch`, via `eslint`, só em
  desenvolvimento; não entra no que roda em produção). O CI barra a partir de severidade alta.

## Próximo passo exato

1. **Fase 2 — Estrutura:** etapas editáveis por lista (com modelos), campos personalizados, itens
   completos, anexos, lixeira, histórico e tempo em cada etapa. Com ela entra o roteador de telas
   definitivo. Começar pelas migrações e pela API (com testes nas duas camadas), depois a tela.
2. Pequenos restos da interface da Fase 1, a encaixar durante a Fase 2: lista das próprias sessões
   (a API já tem), criação de pastas e listas por quem gerencia um espaço sem ser Dono, troca da
   própria senha (falta na API).
3. Itens adiados que dependem da interface: passkeys e CAPTCHA.

## Pendências do mantenedor (Fase 0)

- [ ] Segundo fator (de preferência passkey ou chave física) nas contas GitHub dos mantenedores.
- [ ] Proteção da branch `main`: pull request obrigatório, revisão de mantenedor, CI obrigatório,
      commits assinados, histórico linear, sem force-push. _(Só pode ser ligada depois do primeiro
      commit existir na `main`.)_
- [ ] Ligar "Private vulnerability reporting", "Dependency graph" e alertas do Dependabot.
      ("Secret scanning" com "Push protection" já está ligado.)
- [ ] Segundo mantenedor como colaborador e em `.github/CODEOWNERS`.
- [ ] Confirmar a licença (padrão atual: AGPL-3.0-only).
- [ ] Decidir se o repositório ganha um nome genérico.
