# Andamento

> Arquivo público. Não registra nada de nenhuma instalação: nem domínio, nem servidor, nem nomes.
> Quem retoma o trabalho lê este arquivo e [`DECISIONS.md`](DECISIONS.md) antes de qualquer coisa.

## Onde estamos

**Fase 5 — Automações, pronta no código.** A Fase 1 (fundação e segurança) está pronta, com o percurso em
navegador real rodando no CI. A Fase 2 (estrutura) está completa no código: etapas, campos
personalizados (inclusive pessoas, secreto e arquivos), histórico, lixeira, mover entre listas,
modelos de etapas, delegação, "Minha conta" e anexos; falta o mantenedor revisar e decidir o
antivírus. A Fase 3 está completa: quadro, calendário, tabela, linha do tempo, filtrar, ordenar e
agrupar, visões salvas, ordem à mão, busca global e edição em massa. A Fase 4 está completa:
prioridade, início e prazo, subtarefas, checklist, comentários, menções, recorrência, avisos e
atualização em tempo real. Na Fase 5, as regras por lista estão prontas (quando, se, então, com o
acesso de quem salvou e registro), também por campo alterado e item recebido, preenchendo campos,
pondo prazo e criando subtarefas, quando o prazo chega (pela rotina de hora em hora), e as etapas
que só recebem itens de um papel para cima. A Fase 5 está completa no código; regras agendadas
sem item e mover de lista por regra ficaram para depois (D57). A próxima é a Fase 6 (painéis e
relatórios).

| Fase                                                              | Situação                                |
| ----------------------------------------------------------------- | --------------------------------------- |
| 0. Preparação do repositório (proteções no GitHub)                | depende do mantenedor, ver "Pendências" |
| 1. Fundação e segurança                                           | pronta                                  |
| **2. Estrutura (etapas, campos personalizados, anexos, lixeira)** | pronta no código, aguardando revisão    |
| 3. Visões (lista, quadro, calendário, tabela, linha do tempo)     | pronta no código                        |
| 4. Tarefas e colaboração                                          | pronta no código                        |
| 5. Automações                                                     | pronta no código                        |
| **6. Painéis e relatórios**                                       | **próxima**                             |
| 7. PWA e offline                                                  | a fazer                                 |
| 8. Atualizador assinado                                           | a fazer                                 |
| 9. Backup e restauração                                           | a fazer                                 |
| 10. White label, assistente visual e formulários                  | a fazer                                 |
| 11. Blindagem (revisão independente)                              | a fazer                                 |
| 12. Implantação                                                   | só com autorização do mantenedor        |
| 13. Migração de dados                                             | só com autorização do mantenedor        |

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

- Histórico de cada item (`0012_item_history.sql`): o banco registra, por gatilho, quem criou,
  renomeou, descreveu, moveu de etapa ou de lista, atribuiu e preencheu ou limpou cada campo, com o
  valor de antes e o de depois. A aplicação só lê; nem o dono do banco reescreve ou apaga uma linha
  enquanto o item existir. Quem vê o item vê a história inteira dele; o que um campo arquivado já
  guardou fica tão fora de alcance quanto o valor atual dele.
- Tela: "Histórico" no painel do item, em frases ("Ana Souza preencheu Valor: R$ 250,00"), das
  mais novas para as mais antigas, de 50 em 50.

- Lixeira (`0013_trash.sql`): quem pode editar um item pode mandá-lo para a lixeira e trazê-lo de
  volta. Na lixeira, o item sai de todas as listas e contagens, nada nele muda, e ele volta como
  estava. Depois de 30 dias é removido de vez com tudo o que tinha; o prazo está escrito só no
  banco, e nem o dono do banco antecipa a data sem desligar a proteção. A remoção roda ao iniciar e
  a cada hora, e fica no registro de auditoria.

- Mover item entre listas (`0014_move_items.sql`): quem edita o item e pode editar na lista de
  destino move; o item entra na primeira etapa de lá ou na escolhida. Valores de campos que as duas
  listas têm em comum (mesma origem, mesmo tipo) vão junto quando significam o mesmo lá: opção que
  existe lá, dinheiro na mesma moeda. O resto fica guardado e volta se o item voltar.

- Modelos de etapas: quem gerencia a lista aplica um modelo pronto (genérico), as etapas de outra
  lista ou um arquivo salvo, e exporta as etapas da lista como arquivo. Aplicar cria o que falta e
  ajusta cor e significado das etapas de mesmo nome; nunca remove etapa nem muda item de etapa.
  O arquivo é lido como texto não confiável e recusado com uma frase se não for exatamente um
  conjunto de etapas.

- Delegar (`0015_delegation.sql`): um item só é passado para quem pode trabalhar na lista dele
  (editar ou mais, conta ativa); o banco recusa o resto. Quem distribui trabalho na lista (edita
  todos os itens dela) vê essa lista de pessoas sem precisar gerenciar usuários; quem só vê os
  próprios itens não vê. No painel do item, "Responsáveis".
- "Minha conta" (clicando no próprio nome): trocar a senha com a senha atual e um código do
  autenticador, o que encerra as outras sessões; e ver e encerrar as próprias sessões. Erros contam
  para o bloqueio do aparelho e ficam no registro.

- Campo de pessoas (`0016_people_field.sql`): nomeia até 20 pessoas, só entre as que podem
  trabalhar na lista do item (mesma regra de passar o item). Quem já estava nomeado continua se
  perder o acesso; ninguém novo assim entra. Ao mover o item, o valor só vai junto se todos
  puderem trabalhar na outra lista. Quem distribui trabalho escolhe as pessoas; os demais só leem.

- Anexos (`0017_attachments.sql`, desenho em `docs/design/anexos.md`): seguem o item (quem vê
  baixa, quem edita anexa e remove); guardados fora do banco, cifrados com chave própria por
  arquivo, em partes de 8 MiB que servem também ao envio retomável; nada sai antes do antivírus
  responder; arquivo infectado fica bloqueado e os Donos são alertados; só imagem, áudio e vídeo
  aparecem na própria página, pelo tipo lido do conteúdo; download de lista sensível pede o código
  e fica no registro; lixeira de 30 dias e histórico. O antivírus a usar depende de decisão do
  mantenedor (D33); sem escolha, anexos ficam desligados.

- Campo secreto (`0018_secret_field.sql`, D34): valor cifrado pela API e guardado à parte, numa
  coluna que a API não tem permissão de ler; o único caminho de volta é a função do banco que
  pede ver o item, a capacidade "Revelar campos secretos" e 2º fator recente, e registra cada
  revelação. Listas e histórico mostram só que existe um valor. Na tela, o valor revelado some
  depois de 30 segundos e pode ser copiado sem aparecer. Quem edita o item preenche, troca e
  apaga sem ver.

- Campo de arquivos (`0019_files_field.sql`, D35): diz qual anexo do item é qual; só nomeia anexos
  do próprio item, prontos e fora da lixeira; o que já estava nomeado pode ficar; ao mudar de
  lista, leva só o que ainda está anexado.

- Quem gerencia um espaço ou uma pasta, sem ser Dono, cria pastas e listas ali pela tela (antes
  só pela API). Espaços continuam só com os Donos.

- **Fase 3 começou: quadro** (D36). Uma coluna por etapa, cartões arrastados pela alça com mouse,
  dedo ou caneta, sem dependência nova; menu de etapa no cartão para teclado e leitor de tela;
  cartão aberto numa janela com o painel do item; no celular as colunas rolam de lado.

- Filtrar e ordenar (D37): busca no título sem diferença de acentos, responsável, etapa, uma
  condição por campo (opção, texto, valor mínimo ou máximo, data, preenchido ou vazio) e ordem por
  título, datas ou qualquer campo; vale para a lista e o quadro e fica no endereço.

- Visões salvas (`0020_saved_views.sql`, D38): cada pessoa dá nome a uma forma de olhar a lista
  (lista ou quadro, filtro e ordem) e volta a ela num toque; ninguém mais vê.

- Calendário (`0021_calendar_views.sql`, D39): itens no dia de um campo de data, no fuso de quem
  olha; mês a mês, com "voltar para hoje"; no celular vira agenda; visões salvas guardam também o
  calendário.

- Tabela (`0022_table_views.sql`, D40): colunas escolhidas por pessoa e guardadas no endereço,
  título fixo enquanto o resto rola de lado, ordem pelo clique na coluna, etapa mudada na célula.

- Ordem à mão no quadro (`0023_item_positions.sql`, D41): arrastar dentro da coluna ou "Subir" e
  "Descer"; a mesma ordem para todos; não conta como mudança do item.

- Busca global (`0024_search.sql`, D42): no alto de toda página, pelos títulos e descrições de
  tudo o que a pessoa abre, sem diferença de acentos; cada resultado abre a lista filtrada.

- Linha do tempo (`0025_timeline_views.sql`, D43): uma barra por item entre dois campos de data,
  seis semanas por vez, na cor da etapa; títulos fixos enquanto os dias rolam.

- Agrupar a lista por responsável, por um campo (opções na ordem da lista, com cor) ou sem
  grupos, além da etapa; fica no endereço e nas visões salvas.

- Edição em massa (`0026_bulk_trash.sql`, D44): selecionar itens na lista e mover para uma etapa,
  passar para uma pessoa ou mandar para a lixeira, tudo ou nada; vários para a lixeira pedem a
  capacidade "Apagar em massa" e o código, ficam no registro e alertam os Donos, também direto no
  banco.

- **Fase 4 começou: prioridade, início e prazo** (`0027_priority_dates.sql`, D45). Prioridade de 1
  (Urgente) a 4, início e prazo como dias; o começo nunca depois do prazo; tudo no histórico.
  Marcas na lista e no quadro, "atrasado" para o que passou do prazo sem estar concluído; filtrar
  por prioridade e prazo, ordenar e agrupar por prioridade, colunas na tabela; calendário e linha
  do tempo pelo início e prazo do próprio item.

- Subtarefas (`0028_subtasks.sql`, D46): item com pai da mesma lista, um nível; cada uma segue as
  regras de qualquer item; mover ou mandar o pai para a lixeira leva as subtarefas, e a lixeira
  conta como vários itens; o banco confere a família inteira no fim de cada transação. Na lista,
  dobradas debaixo do pai com quantas estão concluídas.

- Checklist (`0029_checklist.sql`, D47): até 100 linhas por item, seguindo as regras do item;
  quem marcou e quando escritos pelo banco; cada mudança no histórico; "Checklist 1/2" ao lado do
  título.

- Comentários (`0030_comments.sql`, D48): escreve quem edita o item, lê quem o vê; só o autor muda,
  com as versões anteriores legíveis; o autor ou quem gerencia a lista apaga, e o texto sai do
  alcance da aplicação.

- Menções com @ (`0031_mentions.sql`, D49): só quem vê o item, decidido pelo banco com as regras da
  própria pessoa; só o autor menciona; menção feita não muda. Cada item diz os nomes de quem o vê e
  de quem participou dos comentários, para quem o vê.

- Recorrência (`0032_recurrence.sql`, D50): ao terminar, o banco cria o próximo com o que o item
  levava e o prazo um passo adiante, por qualquer caminho; a regra passa para o novo item.

- Avisos (`0033_notifications.sql`, D51): menção, item recebido, comentário num item seu, prazo de
  hoje e atrasado; nunca para quem causou nem para quem não vê o item; cada um lê os seus enquanto
  vê o item. "Avisos" com a contagem no alto de toda página. Alerta de volume de lixeira (D44).

- Tempo real (`0034_live.sql`, D52): o banco anuncia só qual lista e item mudou e de quem é; o
  servidor repassa só a quem pode ver; a página pergunta de novo pelas rotas de sempre.

- Automações (`0035_automations.sql`, D53): regras por lista — quando um item é criado ou entra
  numa etapa, se as condições valem, mover de etapa, mudar a prioridade, passar para alguém, avisar
  ou comentar. A regra age com o acesso de quem a salvou por último, trocado dentro do banco só
  durante a regra; nunca impede a pessoa; o que faz aparece com o nome dela no histórico, nos
  comentários e nos avisos; registro de 90 dias. Em "Automações", para quem gerencia a lista.

- Mais gatilhos e ações (`0036_automation_triggers.sql`, D55): quando um campo muda (ou passa a
  ser um valor) e quando alguém recebe um item; preencher ou limpar campo, prazo daqui a N dias e
  criar subtarefa. O que é feito enquanto o item nasce conta como criação.

- Etapas restritas (`0037_stage_entry.sql`, D56): cada etapa diz quem põe itens nela (quem edita,
  gestores, ADMs ou só Donos), conferido pelo banco em todo caminho, inclusive regras; a página só
  oferece a etapa a quem pode.

- Regras pelo prazo (`0038_automation_due.sql`, D57): de 30 dias antes a 30 depois, uma vez por
  item e prazo, rodadas pela rotina de hora em hora com a identidade do autor só durante a regra;
  a função se recusa a rodar dentro de uma requisição.

- Limite de requisições (D54): toda rota, 1 200 por minuto por sessão (ajustável), e o fluxo de
  tempo real abre no máximo 20 vezes por minuto; a página espera e tenta de novo.

### O que os testes provam (518 testes)

| Arquivo                                          | O que garante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/test/*.test.ts` (28)            | resolução de acesso e regra "ninguém concede o que não tem"; o que cada tipo de campo aceita como configuração e como valor; nome de arquivo sem nada que vire caminho; só tipos inofensivos são mostrados na página; segredo nunca anda com os valores comuns e é guardado exatamente como digitado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/auth.test.ts` (22)                | instalação fechada sem o token; 2º fator obrigatório; código de uso único; dispositivo novo sem sessão até aprovação; convite de uso único; força bruta bloqueada; sessão revogada ou conta suspensa cai na hora; origem cruzada e subdomínio irmão recusados                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/api/test/authorization.test.ts` (20)       | pela API: funcionário A não vê nem altera nada do B; ADM sem concessão não vê nada; ADM não concede fora da própria área nem para iguais ou superiores; ninguém se promove; lista sensível exige 2º fator; o 2º fator pode ser confirmado depois de um tempo parado; o último Dono não pode ser rebaixado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/test/database.test.ts` (24)            | direto no banco, com as credenciais da API e sem código da API: as mesmas garantias; identidade não pode ser forjada nem sobrevive à transação; quem só pode ver uma lista não altera nada nela nem move itens para dentro ou para fora; credenciais inalcançáveis; auditoria não pode ser editada nem apagada; adulteração com acesso total é detectada; toda tabela tem RLS; nenhuma função aberta a `PUBLIC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/crypto.test.ts` (16)              | argon2id com sal novo; cifra autenticada presa à linha e à finalidade; resumo com chave para códigos de recuperação; tokens de 256 bits; TOTP sem repetição; segredos com permissão `0600` e nunca sobrescritos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/stages.test.ts` (21)              | pela API e direto no banco: item sempre em uma etapa da própria lista; lista nunca sem etapa; só quem gerencia altera etapas; funcionário move só o que é dele; o histórico de etapas não pode ser escrito nem apagado pela aplicação; etapa em uso não some sem destino; item criado por quem só vê os seus nasce atribuído a quem criou                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/test/fields.test.ts` (30)              | pela API e direto no banco: só quem gerencia a lista muda os campos; valores seguem o item (lidos por quem o vê, escritos por quem o edita, e por mais ninguém); valor que não cabe no tipo é recusado nas duas camadas, e as duas concordam; tipo, lista e origem de um campo não mudam; opção e campo são arquivados, nunca apagados; valor de campo arquivado ou de lista que o item deixou fica fora de alcance; cópia só pode se dizer "o mesmo campo" de um campo que a pessoa vê                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/history.test.ts` (12)             | pela API e direto no banco: toda mudança entra no histórico com autor, antes e depois, por qualquer caminho; salvar sem mudar nada não acrescenta linha; ninguém escreve, corrige ou apaga o histórico, nem um Dono, nem o dono do banco; funcionário lê só a história dos próprios itens; o passado de um campo arquivado ou deixado em outra lista não é lido                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/trash.test.ts` (11)               | pela API e direto no banco: item na lixeira some da lista de todos e aparece só na lixeira de quem o via; só quem edita manda e traz de volta; nada nele nem no que pende dele muda; a data e quem mandou são escritas pelo banco; ninguém remove item, só a limpeza depois de 30 dias, que leva tudo junto e fica na auditoria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/move.test.ts` (9)                 | pela API e direto no banco: só quem edita o item e a lista de destino move; o item cai na etapa certa e o histórico registra; vão junto só os valores de campos de mesma origem que significam o mesmo lá (não opção que não existe, não dinheiro em outra moeda, não campo arquivado); o que fica volta com o item; nada é escrito numa lista para onde a pessoa não poderia mover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/api/test/stage-sets.test.ts` (4)           | aplicar um conjunto cria o que falta, ajusta o que tem o mesmo nome, põe o conjunto primeiro e não tira nem move nada; todos os modelos prontos são aceitos; só quem gerencia a lista aplica; conjunto malformado ou acima do limite é recusado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/account.test.ts` (9)              | trocar a senha exige a senha atual e um código, encerra as outras sessões na hora e fica no registro; senha ou código errado é recusado do mesmo jeito e contado; nova senha segue as regras e não repete a atual; cada um vê e encerra só as próprias sessões; só quem distribui trabalho na lista vê quem pode recebê-lo; banco recusa passar item para quem não pode editar a lista, para quem só vê, ou para conta suspensa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/people-field.test.ts` (6)         | pela API e direto no banco: o campo só nomeia quem pode editar a lista (nem quem só vê, nem quem não tem acesso); quem perdeu o acesso continua onde estava, mas não volta depois de sair; ao mover, só vai junto se todos puderem trabalhar lá; banco e API concordam sobre o formato                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api/test/attachments.test.ts` (23)         | pela API e direto no banco: o arquivo volta byte a byte como foi enviado; o envio continua de onde parou; no disco só há ruído sem nome, e conteúdo alterado ou trocado é recusado; nada sai antes do antivírus, nem quando ele está fora do ar, e ele só é chamado depois que o envio foi gravado de vez; infectado fica bloqueado com alerta; anexo segue o item (colega e quem não tem acesso não veem nem o nome); envio é só de quem começou até terminar; lista sensível pede o código e registra cada download; só imagem, áudio e vídeo aparecem na página, e trechos de áudio e vídeo chegam sem baixar tudo; lixeira de 30 dias, depois o conteúdo é apagado; ninguém marca arquivo como verificado, muda o resumo ou forja quem enviou                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/api/test/secret-field.test.ts` (14)        | pela API e direto no banco: o valor fica cifrado, fora de toda lista e do histórico; a API não consegue ler a coluna cifrada; revelar exige ver o item, a capacidade de revelar e código recente, e cada revelação fica no registro; quem só vê não troca; nada muda na lixeira; o segredo fica na lista de origem quando o item muda de lista e volta com ele; valor copiado para outra linha não abre; quem trocou por último é escrito pelo banco                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/files-field.test.ts` (4)          | pela API e direto no banco: o campo só nomeia anexos do próprio item, prontos e fora da lixeira, nem pelo dono do banco; o que já estava nomeado pode ficar, mas não volta depois de sair; ao mudar de lista leva só o que ainda está anexado, e sem nada anexado o valor fica para trás em vez de travar a mudança                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/api/test/structure.test.ts` (4)            | quem gerencia um espaço ou uma pasta, sem ser Dono, cria pastas e listas ali e em nenhum outro lugar, e não cria espaços; quem só trabalha numa lista não cria nada em volta dela; a árvore diz a cada pessoa onde ela pode criar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/api/test/views.test.ts` (6)                | pela API e direto no banco: cada pessoa lê, cria, renomeia e apaga só as próprias visões, nem colega, gestor ou Dono alcança as dos outros, nem com comandos que não apontam uma linha; só para listas que a pessoa abre, e quem perde o acesso perde as visões junto; só texto de endereço é aceito; nomes não se repetem; no máximo 30 por lista                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api/test/order.test.ts` (4)                | pela API e direto no banco: a ordem da coluna fica como foi dada, sem mudar a "última mudança" nem o histórico; item que muda de etapa vai para o fim; tudo ou nada quando há um item que a pessoa não pode editar ou de outra etapa; quem só vê não ordena                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/api/test/search.test.ts` (5)               | a busca acha só o que cada pessoa abriria (funcionário só os seus, quem não tem acesso nada), sem diferença de acentos e com todas as palavras; acha na descrição depois dos títulos; lista sensível sem código recente e lixeira ficam de fora; o que é digitado vale literalmente                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/api/test/bulk.test.ts` (5)                 | pela API e direto no banco: mudar vários itens é tudo ou nada, só com o que a pessoa pode mudar; passar vários só por quem distribui trabalho e só para quem pode trabalhar na lista; vários para a lixeira exigem a capacidade e código recente, ficam no registro e alertam os Donos; no banco, mandar um por vez na mesma requisição conta junto; um só continua como o botão do item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/test/priority-dates.test.ts` (7)       | pela API e direto no banco: prioridade de 1 a 4 e datas que existem, cada uma mudada sem mexer nas outras e limpa com nulo; começo depois do prazo recusado, contando o que fica guardado; só quem edita o item define, nem quem só vê nem quem não vê o item, nem com comandos que não apontam uma linha; nada muda na lixeira; cada mudança no histórico com autor, antes e depois, também quando feita direto no banco; o histórico não aceita linha forjada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/subtasks.test.ts` (13)            | pela API e direto no banco: subtarefa só debaixo de item da mesma lista que não é subtarefa e que o autor pode editar; segue as regras de qualquer item (a do colega não aparece para a funcionária); mover o pai leva as subtarefas, mover a subtarefa sozinha a solta, e nada se move se uma não for de quem move; lixeira do pai leva as subtarefas, pede a capacidade e o código, e a restauração traz só as que foram junto; subtarefa restaurada sem o pai volta solta; o banco recusa no fim da transação qualquer família quebrada (pai ou filha movidos sozinhos, pai na lixeira sozinho, neta, pai virando filho, filha de volta sem o pai) e item que é pai de si mesmo; item na lixeira não muda pai, prioridade nem prazo                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api/test/checklist.test.ts` (7)            | pela API e direto no banco: linhas na ordem, marcadas e desmarcadas, contadas no item; lidas por quem vê o item e mudadas só por quem o edita, nem por quem só vê, nem com comandos que não apontam uma linha; vazias, longas ou acima de 100 recusadas nas duas camadas; quem marcou e quando escritos pelo banco, sem forjar autor, data ou item, nem pelo dono do banco; nada muda na lixeira e as linhas saem junto com o item; histórico com o texto de cada linha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/comments.test.ts` (7)             | pela API e direto no banco: escreve quem edita o item, lê quem o vê, em ordem; só o autor muda e cada versão anterior fica legível; o autor ou quem gerencia a lista apaga, e depois ninguém lê o texto nem as versões; colega que edita o item não muda nem apaga o que outro escreveu; quem só vê lê e não escreve, nem com comandos que não apontam uma linha; autor, horários e quem apagou escritos pelo banco, versões intocáveis e comentário que não muda de item nem pelo dono do banco; nada muda na lixeira; vazio recusado nas duas camadas; cada pessoa recebe o que pode fazer com cada comentário                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api/test/mentions.test.ts` (8)             | pela API e direto no banco: os nomes de um item vão só para quem o vê, e só de quem o vê ou participou; só quem vê o item é mencionado, tudo ou nada, e passar o item torna a pessoa mencionável; a concessão mais próxima vale (sem acesso na lista vence gerenciar o espaço); conta suspensa não vê; só o autor menciona; menção não muda nem some, nem pelo dono do banco; nada em comentário apagado ou item na lixeira; até 20                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apps/api/test/recurrence.test.ts` (7)           | pela API e direto no banco: só quem edita o item define a regra, em unidades inteiras de 1 a 99, nas duas camadas, e cada mudança fica no histórico; ao terminar nasce o próximo com título, descrição, prioridade, início e prazo um passo adiante, responsáveis, campos e checklist desmarcada, e a regra passa para ele; atrasado cai hoje ou depois, sem prazo um passo depois de hoje, fim de mês vira o último dia de fevereiro; nada entre etapas abertas, de concluído para encerrado, na lixeira (nem quando a etapa é removida) ou sem regra; o próximo é de quem terminou, também funcionária, e fica debaixo do mesmo pai; por qualquer caminho, com quem definiu a regra escrito pelo banco; regra não muda de item nem pelo dono do banco                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/notifications.test.ts` (8)        | pela API e direto no banco: avisa quem recebe um item, quem tem o item comentado (ou quem o criou, sem responsável) e quem é mencionado (no lugar do aviso de comentário), nunca quem causou; lembra prazo de hoje e atrasado uma vez, nem concluído nem na lixeira; nada para quem não vê o item, por nenhum caminho; cada um vê e conta só os seus enquanto vê o item, e marca só os seus, nem com comandos que não apontam uma linha; ninguém escreve, apaga ou reescreve um aviso, nem o dono do banco; horário de leitura escrito pelo banco; dez itens na lixeira em dez minutos, um por vez, alertam os Donos uma vez                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/api/test/live.test.ts` (6)                 | quem ouve o quê: mudança de lista para quem abre a lista, de item só para quem vê todos os itens ou para quem o item é, avisos e acesso só para a própria pessoa; o banco anuncia lista, item e de quem é, e nunca título nem texto; pelo fluxo de verdade, a funcionária ouve do próprio item e não do item do colega nem da lista sensível; só com sessão, e até 5 por pessoa                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api/test/automations.test.ts` (22)         | pela API e direto no banco: só quem gerencia a lista vê as regras e só quem também tem a permissão escreve, nem direto no banco (nem quem edita itens, com permissão); ninguém forja com o acesso de quem a regra age, e salvar faz a regra agir como quem salvou; cada etapa, campo e pessoa da regra é da própria lista, conferido pelo banco para qualquer um; age em item novo já com responsáveis e campos, e em mudança de etapa de/para, só quando todas as condições valem e só no próprio tipo de gatilho; pausada não age; mesma etapa de novo, item na lixeira, item levado para outra lista, importação e manutenção não disparam; nada além do que o autor pode (sem acesso, só olhando, lista sensível, só os próprios itens não distribui trabalho); regra que falha é desfeita inteira e anotada, e a ação da pessoa fica; regras encadeadas param no terceiro nível; a pessoa volta a ser ela mesma; histórico, comentário e aviso levam o nome da regra; aviso nunca para quem causou nem para quem não vê; registro imutável, 90 dias, apagado com a regra                                          |
| `apps/api/test/automation-triggers.test.ts` (11) | pela API e direto no banco: gatilho por campo e por item recebido só com campo, valor e pessoa que cabem na lista; ação de campo conferida contra o tipo (sem segredo nem arquivos, caixa desmarcada é limpar), prazo de 0 a 365 dias, subtarefa com título; age quando o campo muda para o valor dito ou para qualquer um, nunca com o mesmo valor de novo nem no que é preenchido ao criar; age quando a pessoa dita (ou qualquer uma) recebe o item, nunca quando quem cria entra nele; preenche e limpa campos como o autor, marcado como a regra; prazo que não cabe e opção arquivada desfazem a regra inteira; subtarefa pelo autor, sem espaços, nunca debaixo de subtarefa; corrente pelos novos gatilhos para no terceiro nível; importação não dispara                                                                                                                                                                                                                                                                                                                                                      |
| `apps/api/test/stage-entry.test.ts` (4)          | pela API e direto no banco: só quem gerencia a lista restringe uma etapa, de gestor para cima (nunca "funcionário", nem direto no banco); abaixo do papel, mover, criar na etapa e levar de outra lista escolhendo a etapa são recusados com 403 e o item fica; ADM e Dono passam; tirar da etapa é livre; cair sozinho na primeira etapa restrita (criar sem etapa, mudar de lista sem escolher) é permitido; regra de quem não tem o papel falha inteira; manutenção pelo dono do banco não é barrada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/automation-due.test.ts` (5)       | gatilho de prazo só de 30 dias antes a 30 depois, conferido pelo banco, com o resto da regra conferido como sempre; a rotina age em item não concluído e fora da lixeira, no dia certo, como o autor e marcada como a regra, uma vez por item e prazo (prazo novo é nova ocasião), pausada não age; avisa todos os que veem o item; autor sem acesso fica anotado; dispara as regras de etapa; ninguém fica agindo depois, e a função se recusa a rodar dentro de uma requisição                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api/test/limits.test.ts` (3)               | toda rota tem limite por minuto, contado por sessão e não por endereço; acima dele, 429 com quanto esperar; o fluxo de tempo real tem limite menor; o limite da instalação só aceita números de 60 a 100 000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/api/test/scale.test.ts` (2)                | uma lista de 500 itens com 8 campos abre em bem menos de um segundo para Dono, gestor e funcionário, e continua mostrando a cada um só o que é seu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api/test/web.test.ts` (9)                  | a página vem com a política que proíbe código embutido e de outras origens; nenhum arquivo de fora da pasta, oculto ou de tipo desconhecido é servido; endereços da API nunca respondem com a página; a API continua recusando outras origens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/web/test/*.test.ts` (122)                  | a página compilada só carrega arquivos próprios, sem nada embutido; mensagens de erro nunca mostram detalhe técnico; durações e datas escritas por extenso; números, dinheiro e datas lidos e digitados como se escreve em português; um valor guardado só vira link se o endereço for seguro de abrir; um arquivo de etapas exportado é lido de volta igual, e qualquer outro é recusado com uma frase; cada linha do histórico vira uma frase, sem nomear pessoa ou lista que quem lê não pode ver; o envio de arquivo manda só as partes que faltam, tenta de novo quando a conexão cai, desiste quando o servidor recusa e para quando a pessoa cancela; atrasado é só o que passou do prazo sem estar concluído, e "próximos 7 dias" conta hoje e os seis seguintes; prioridade e prazo filtram, ordenam (vazios por último) e agrupam; calendário e linha do tempo leem o início e o prazo do próprio item; subtarefas ficam debaixo do pai só quando ele aparece, e o histórico só nomeia o pai para quem o vê; menções vão só para quem ainda está no texto e aparecem em destaque, o nome mais longo primeiro |

**Percurso em navegador real** (`apps/web/e2e`, 39 passos, job "Percurso em navegador real" no CI):
um Dono no computador e uma funcionária no celular, contra uma instalação criada do zero pelos
mesmos comandos de produção. Instalação recusada sem o token do servidor; senha fraca explicada na
hora; mesma resposta para senha errada e e-mail inexistente; só a senha não abre nada; convite
aceito no celular e recusado na segunda vez; aparelho novo sem nenhum acesso até a aprovação;
aprovação que exige o 2º fator de novo; funcionária sem nenhum dado nem tela de administração;
uma lista liberada e só ela visível; itens criados e movidos entre etapas pelas duas pessoas, cada
uma vendo só o que pode; campos criados pelo Dono, preenchidos pelas duas pessoas, com valor
inválido barrado antes de enviar e campo arquivado e restaurado sem perder nada; histórico do item
lido em frases; item mandado para a lixeira e restaurado como estava; item levado para a lista sensível e trazido
de volta com os valores intactos; etapas exportadas como arquivo, modelo pronto aplicado, arquivo
errado recusado e arquivo salvo importado; item passado para a funcionária, que o encontra na hora e não
vê a escolha de responsáveis; campo de pessoas preenchido pela Dona e só lido pela funcionária; imagem e texto anexados pelo celular, imagem mostrada na página, texto só baixado e recebido no computador idêntico ao enviado, anexo removido e restaurado e tudo isso no histórico; senha guardada pela funcionária, que não consegue lê-la de volta, e revelada pela Dona só depois do código; campo de arquivos que oferece só os anexos do item; funcionária que passa a gerenciar o espaço cria uma lista nele, sem poder criar espaços; quadro com cartão arrastado de uma coluna para outra, que continua lá depois de recarregar, movido de volta pelo menu de etapa, aberto numa janela, e no celular só o quadro rola de lado; cartão posto à mão uma posição acima, ordem mantida depois de recarregar; lista filtrada pelo título e por valor digitado como se escreve aqui, ordenada por um campo, filtro mantido depois de recarregar e no quadro, salvo como visão com nome e trazido de volta num toque; lista agrupada por responsável e pelas opções de um campo; calendário com o item no dia de hoje, aberto numa janela, navegação entre meses e, no celular, só os dias com itens; tabela ordenada pelo clique na coluna, colunas escolhidas que voltam depois de recarregar, etapa mudada na célula; busca no alto da página que leva à lista já filtrada; linha do tempo com a barra no dia certo, semanas para a frente e de volta para hoje; dois itens selecionados movidos de etapa e passados para a funcionária de uma vez, e mandados juntos para a lixeira só depois do código; prioridade e prazo definidos no item, começo depois do prazo explicado antes de salvar, item atrasado em destaque e achado pelo filtro, mudança no histórico, e as mesmas marcas no celular da funcionária; duas subtarefas criadas pelo painel, dobradas debaixo do pai com a contagem de concluídas, invisíveis para a funcionária a quem o pai foi passado, uma solta do pai e as duas mandadas para a lixeira; checklist preenchida pela Dona e completada pela funcionária no celular, com a marca e o histórico; comentário da Dona respondido e corrigido pela funcionária no celular, sem poder mexer no da Dona, versão anterior lida e comentário apagado pela Dona; menção que oferece só quem vê o item, lida pela funcionária com o nome da Dona e o próprio em destaque; item semanal terminado que volta na primeira etapa com o prazo uma semana adiante; avisos da funcionária contados no alto da página, lidos em frases no celular, um aberto que leva ao item e todos marcados como lidos; linha de checklist e comentário da Dona que aparecem sozinhos no celular da funcionária, com a contagem de avisos; Dona troca a própria senha e continua conectada; lista sensível
fechada até o código; regra criada pela Dona que passa o item terminado para a funcionária e comenta com o próprio nome, avisando-a, e depois pausada e apagada; registro de auditoria íntegro; suspensão que derruba a sessão
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
Nas regras de anexos foram 23 enfraquecimentos: 22 derrubam ao menos um teste (quatro só depois
de testes novos: concluir o envio de outra pessoa, mexer nas partes de um envio já concluído, ler
as partes de um arquivo alheio e alterar o que um arquivo foi ao ser enviado, até pelo dono do
banco). O que sobra é redundante por desenho: gravar partes de um envio alheio já é barrado porque
o envio de outra pessoa nem aparece para quem tenta.
No campo secreto foram 16 enfraquecimentos, todos derrubam testes (três só depois de testes
novos: quem trocou por último, revelar sem ver o item tendo a capacidade, e quem só vê gravando
onde ainda não há valor).
No campo de arquivos foram 7 enfraquecimentos, todos derrubam testes.
Na ordem à mão foram 3, todos derrubam testes. Na lixeira em massa foram 5, todos derrubam testes. Na prioridade e nas datas foram 9, todos derrubam testes. Nas subtarefas foram 16: 15 derrubam testes (dois só depois de testes novos: item pai de si mesmo e filha restaurada sem o pai); o que sobra é redundante por desenho (quem só vê uma lista não insere nem muda itens nela). No tempo real foram 7, todos derrubam testes. Nas regras pelo prazo foram 24: 23 derrubam testes (um só depois de teste novo: prazo novo do mesmo item); o restante é redundante por desenho (a regra sempre age sem código recente, qualquer que seja o contexto de base da rotina). Nas etapas restritas foram 9: 8 derrubam testes; o restante é redundante por desenho (quem não diz quem é já é barrado pelas regras de linha antes). Nos novos gatilhos e ações foram 44: 42 derrubam testes (dois só depois de testes novos: título de subtarefa com espaços direto no banco e o valor do campo que mudou); os outros dois mostraram código que não fazia diferença, e esse código saiu. Nas automações foram 83: 81 derrubam testes (dezoito só depois de testes novos, entre eles condições que não valem, regra pausada, gatilho de outro tipo, mesma etapa de novo, item jogado fora na mesma requisição, importação sem registro, caixa de marcar e campo de texto nas condições, quem só edita itens com a permissão, e comentário de regra apagável); os dois restantes repetem outra camada (o registro só aparece para quem vê a regra, que já tem a mesma regra de linha; condição de tipo desconhecido já é recusada ao salvar). Nos avisos foram 20, todos derrubam testes (cinco só depois de testes novos: marcar os de outra pessoa sem apontar uma linha, aviso e lembrete para quem não vê o item, e lembrete de item na lixeira). Na recorrência foram 20, todos derrubam testes (cinco só depois de testes novos: unidade e intervalo direto no banco, leitura da regra alheia, item na lixeira quando a etapa é removida e de concluído para encerrado). Nas menções foram 17: 15 derrubam testes (quatro só depois de testes novos: concessão mais próxima, nível de acesso, menções de comentário apagado e quem não participa); os dois restantes são as duas camadas que se cobrem em "só o autor menciona". Nos comentários foram 20: 18 derrubam testes (cinco só depois de testes novos: vazio direto no banco, lixeira direto no banco, e comentário mudado de item, apagado já na criação ou com autor de apagamento forjado pelo dono do banco); os dois restantes repetem regras de outra camada (a tabela repete o gatilho; a regra de linha já barra quem não é autor nem gerente). Na checklist foram 16, todos derrubam testes (três só depois de testes novos: o limite direto no banco, e linha mudada de item ou data de tique forjada pelo dono do banco). Nas visões salvas foram 6, todos derrubam testes (três só depois de testes com comandos que não
apontam uma linha e com gravação numa lista que a pessoa não abre).

### Como rodar

```sh
pnpm install --frozen-lockfile
export TEST_PG_ADMIN_URL='postgres://postgres:<senha>@127.0.0.1:5432/postgres'   # PostgreSQL 16+ descartável
pnpm check
```

## Ainda não verificado

- O serviço `clamav` de `infra/compose.yaml` (perfil `antivirus`) não foi levantado neste
  trabalho: a conversa com o ClamAV segue o protocolo dele e é testada com um verificador falso. O
  CI sobe a instalação sem esse perfil.
- Os workflows rodaram e passaram na `main` (CI, CodeQL, Scorecard). O passo "Revisão das
  dependências novas do PR" reprova enquanto o "Dependency graph" estiver desligado nas
  configurações do repositório (ver "Pendências").
- As imagens base ainda são referenciadas por tag, não por digest. Fixar no pipeline de release
  (Fase 8).
- `pnpm audit` aponta 1 aviso de severidade moderada (`minimatch`, via `eslint`) e, desde 18/11,
  1 alto (GHSA-fc5q-39xc-vjpf, `picomatch` até 4.0.7, via `typescript-eslint`). Os dois são só de
  desenvolvimento, com padrões escritos no próprio repositório, e não entram no que roda em
  produção. O alto ainda não tem versão corrigida: o passo "Vulnerabilidades conhecidas" do CI
  fica vermelho em todo PR até sair a correção (aí basta atualizar o `picomatch`, respeitando os 3
  dias). Nenhuma exceção foi aberta no CI; abrir uma é decisão do mantenedor.

## Próximo passo exato

1. **Fase 6 — painéis e relatórios:** painéis com totais por etapa, por pessoa e por prazo, com as
   mesmas regras de leitura (cada pessoa vê nos números só o que vê na lista), começando pelos
   cartões de contagem e o tempo em cada etapa.
2. Itens adiados que dependem da interface: passkeys e CAPTCHA.

Cada fatia, sempre nesta ordem: migração e API com testes nas duas camadas, depois a tela e o
passo no percurso em navegador.

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
