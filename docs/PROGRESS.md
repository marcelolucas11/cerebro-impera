# Andamento

> Arquivo público. Não registra nada de nenhuma instalação: nem domínio, nem servidor, nem nomes.
> Quem retoma o trabalho lê este arquivo e [`DECISIONS.md`](DECISIONS.md) antes de qualquer coisa.

## Onde estamos

**Fase 2 — Estrutura, em andamento.** A Fase 1 (fundação e segurança) está pronta, com o percurso
em navegador real rodando no CI. Da Fase 2 já existem as etapas por lista, o tempo em cada etapa e
a tela de lista agrupada por etapa e os campos personalizados. Falta o que está em "Próximo passo".

| Fase                                                              | Situação                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| 0. Preparação do repositório (proteções no GitHub)                | depende do mantenedor, ver "Pendências"                  |
| 1. Fundação e segurança                                           | pronta, salvo os restos listados abaixo                  |
| **2. Estrutura (etapas, campos personalizados, anexos, lixeira)** | **em andamento: etapas, tela de lista e campos prontos** |
| 3. Visões (lista, quadro, calendário, tabela, linha do tempo)     | a fazer                                                  |
| 4. Tarefas e colaboração                                          | a fazer                                                  |
| 5. Automações                                                     | a fazer                                                  |
| 6. Painéis e relatórios                                           | a fazer                                                  |
| 7. PWA e offline                                                  | a fazer                                                  |
| 8. Atualizador assinado                                           | a fazer                                                  |
| 9. Backup e restauração                                           | a fazer                                                  |
| 10. White label, assistente visual e formulários                  | a fazer                                                  |
| 11. Blindagem (revisão independente)                              | a fazer                                                  |
| 12. Implantação                                                   | só com autorização do mantenedor                         |
| 13. Migração de dados                                             | só com autorização do mantenedor                         |

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

## Feito na Fase 2 (até aqui)

- Etapas por lista (`0008_stages.sql`): cada lista tem as próprias etapas, com nome, cor, ordem e
  significado (a fazer, em andamento, concluído, encerrado). Todo item está sempre em uma etapa da
  própria lista; uma lista nunca fica sem etapa; remover uma etapa em uso exige dizer para onde vão
  os itens.
- Tempo em cada etapa: o banco, e só ele, registra quando o item entrou e saiu de cada etapa e quem
  moveu. A aplicação não consegue escrever nem corrigir esse histórico.
- Quem vê a lista vê as etapas; só quem gerencia a lista altera as etapas; quem edita um item pode
  movê-lo de etapa.
- Tela de lista (`/listas/:id`): itens agrupados por etapa, mudança de etapa na própria linha,
  criação de item dentro da etapa, painel do item com título, descrição e o tempo em cada etapa, e
  editor de etapas para quem gerencia. Lista sensível só abre depois do 2º fator.
- Item criado por quem só enxerga os próprios itens já nasce atribuído a essa pessoa
  (`0009_self_assignment.sql`); antes ele sumia da tela de quem acabou de criar.

- Campos personalizados (`0011_custom_fields.sql`): cada lista define o que anota sobre os itens.
  Treze tipos: texto, texto longo, número, dinheiro, data, data e hora, escolha única, marcadores,
  sim ou não, link, e-mail, telefone e nota. Quem gerencia a lista cria, renomeia, ordena e arquiva
  campos; quem edita um item preenche. Nada é apagado: campo e opção arquivados somem da tela e
  guardam o que foi preenchido. Campos podem ser copiados de outra lista e continuam contando como
  o mesmo campo nas duas.
- O valor de cada campo é conferido duas vezes, pela API e pelo banco, com as mesmas regras (um
  teste compara as duas respostas caso a caso).
- Tela: editor de campos, colunas na lista (os quatro primeiros campos), preenchimento ao abrir o
  item com erro explicado antes de enviar, e leitura em texto corrido no celular.
- Regras de leitura reescritas para o banco calcular o acesso da pessoa uma vez por consulta, e não
  uma vez por linha (`0010_read_policies_once_per_statement.sql`). Abrir uma lista de 500 itens com
  8 campos preenchidos caiu de cerca de 2 segundos para cerca de 30 milissegundos, com 20 mil itens
  no banco. Quem vê o quê não mudou, e um teste impede a lentidão de voltar.

### O que os testes provam (194 testes)

| Arquivo                                    | O que garante                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/test/*.test.ts` (23)      | resolução de acesso e regra "ninguém concede o que não tem"; o que cada tipo de campo aceita como configuração e como valor                                                                                                                                                                                                                                                                                                                                                             |
| `apps/api/test/auth.test.ts` (22)          | instalação fechada sem o token; 2º fator obrigatório; código de uso único; dispositivo novo sem sessão até aprovação; convite de uso único; força bruta bloqueada; sessão revogada ou conta suspensa cai na hora; origem cruzada e subdomínio irmão recusados                                                                                                                                                                                                                           |
| `apps/api/test/authorization.test.ts` (20) | pela API: funcionário A não vê nem altera nada do B; ADM sem concessão não vê nada; ADM não concede fora da própria área nem para iguais ou superiores; ninguém se promove; lista sensível exige 2º fator; o 2º fator pode ser confirmado depois de um tempo parado; o último Dono não pode ser rebaixado                                                                                                                                                                               |
| `apps/api/test/database.test.ts` (24)      | direto no banco, com as credenciais da API e sem código da API: as mesmas garantias; identidade não pode ser forjada nem sobrevive à transação; quem só pode ver uma lista não altera nada nela nem move itens para dentro ou para fora; credenciais inalcançáveis; auditoria não pode ser editada nem apagada; adulteração com acesso total é detectada; toda tabela tem RLS; nenhuma função aberta a `PUBLIC`                                                                         |
| `apps/api/test/crypto.test.ts` (16)        | argon2id com sal novo; cifra autenticada presa à linha e à finalidade; resumo com chave para códigos de recuperação; tokens de 256 bits; TOTP sem repetição; segredos com permissão `0600` e nunca sobrescritos                                                                                                                                                                                                                                                                         |
| `apps/api/test/stages.test.ts` (21)        | pela API e direto no banco: item sempre em uma etapa da própria lista; lista nunca sem etapa; só quem gerencia altera etapas; funcionário move só o que é dele; o histórico de etapas não pode ser escrito nem apagado pela aplicação; etapa em uso não some sem destino; item criado por quem só vê os seus nasce atribuído a quem criou                                                                                                                                               |
| `apps/api/test/fields.test.ts` (30)        | pela API e direto no banco: só quem gerencia a lista muda os campos; valores seguem o item (lidos por quem o vê, escritos por quem o edita, e por mais ninguém); valor que não cabe no tipo é recusado nas duas camadas, e as duas concordam; tipo, lista e origem de um campo não mudam; opção e campo são arquivados, nunca apagados; valor de campo arquivado ou de lista que o item deixou fica fora de alcance; cópia só pode se dizer "o mesmo campo" de um campo que a pessoa vê |
| `apps/api/test/scale.test.ts` (2)          | uma lista de 500 itens com 8 campos abre em bem menos de um segundo para Dono, gestor e funcionário, e continua mostrando a cada um só o que é seu                                                                                                                                                                                                                                                                                                                                      |
| `apps/api/test/web.test.ts` (9)            | a página vem com a política que proíbe código embutido e de outras origens; nenhum arquivo de fora da pasta, oculto ou de tipo desconhecido é servido; endereços da API nunca respondem com a página; a API continua recusando outras origens                                                                                                                                                                                                                                           |
| `apps/web/test/*.test.ts` (27)             | a página compilada só carrega arquivos próprios, sem nada embutido; mensagens de erro nunca mostram detalhe técnico; durações e datas escritas por extenso; números, dinheiro e datas lidos e digitados como se escreve em português; um valor guardado só vira link se o endereço for seguro de abrir                                                                                                                                                                                  |

**Percurso em navegador real** (`apps/web/e2e`, 13 passos, job "Percurso em navegador real" no CI):
um Dono no computador e uma funcionária no celular, contra uma instalação criada do zero pelos
mesmos comandos de produção. Instalação recusada sem o token do servidor; senha fraca explicada na
hora; mesma resposta para senha errada e e-mail inexistente; só a senha não abre nada; convite
aceito no celular e recusado na segunda vez; aparelho novo sem nenhum acesso até a aprovação;
aprovação que exige o 2º fator de novo; funcionária sem nenhum dado nem tela de administração;
uma lista liberada e só ela visível; itens criados e movidos entre etapas pelas duas pessoas, cada
uma vendo só o que pode; campos criados pelo Dono, preenchidos pelas duas pessoas, com valor
inválido barrado antes de enviar e campo arquivado e restaurado sem perder nada; lista sensível
fechada até o código; registro de auditoria íntegro; suspensão que derruba a sessão
na hora; e nenhuma violação da política de segurança da página do começo ao fim. Esse percurso já pegou
três defeitos reais, todos corrigidos e cobertos por teste: a tela de pessoas mostrava situação
desatualizada; item criado por funcionária aparecia sem responsável e sumia para ela; e confirmar o
2º fator depois de um minuto parado travava a requisição (ver D22).

Os testes do banco foram conferidos por mutação: enfraquecer de propósito uma regra (identidade
que sobrevive à transação, funcionário vendo a lista inteira, concessão sem gerenciar o escopo) faz
testes falharem; as regras restauradas voltam a passar. Nas regras de campos e nas regras de
leitura reescritas foram 40 enfraquecimentos, um por vez. Seis passaram na primeira rodada: quatro
mostraram lacunas nos testes (quem só pode ver uma lista tentando alterar, preencher ou mover itens
direto no banco), que foram fechadas; dois são redundantes por desenho (outra camada faz a mesma
recusa).

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

1. **Fase 2 — Estrutura, o que falta:** histórico de alterações do item (quem mudou o quê,
   escrito pelo banco), lixeira com prazo, anexos, campo secreto (cifrado, com revelação
   registrada), campo de arquivo (junto com anexos), campo de pessoa (junto com a lista de pessoas
   para delegar), mover item entre listas levando os campos de mesma origem, e modelos de etapas
   reutilizáveis. Sempre nesta ordem: migração e API com testes nas duas camadas, depois a tela e
   o passo no percurso em navegador.
2. Pequenos restos da interface da Fase 1, a encaixar durante a Fase 2: lista das próprias sessões
   (a API já tem), criação de pastas e listas por quem gerencia um espaço sem ser Dono, troca da
   própria senha (falta na API), e uma lista de pessoas para delegar itens sem precisar da
   capacidade de gerenciar usuários.
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
