# Andamento

> Arquivo público. Não registra nada de nenhuma instalação: nem domínio, nem servidor, nem nomes.
> Quem retoma o trabalho lê este arquivo e [`DECISIONS.md`](DECISIONS.md) antes de qualquer coisa.

## Onde estamos

**Fase 3 — Visões, pronta no código.** A Fase 1 (fundação e segurança) está pronta, com o percurso em
navegador real rodando no CI. A Fase 2 (estrutura) está completa no código: etapas, campos
personalizados (inclusive pessoas, secreto e arquivos), histórico, lixeira, mover entre listas,
modelos de etapas, delegação, "Minha conta" e anexos; falta o mantenedor revisar e decidir o
antivírus. A Fase 3 está completa: quadro, calendário, tabela, linha do tempo, filtrar, ordenar e
agrupar, visões salvas, ordem à mão, busca global e edição em massa. A próxima é a Fase 4.

| Fase                                                              | Situação                                |
| ----------------------------------------------------------------- | --------------------------------------- |
| 0. Preparação do repositório (proteções no GitHub)                | depende do mantenedor, ver "Pendências" |
| 1. Fundação e segurança                                           | pronta                                  |
| **2. Estrutura (etapas, campos personalizados, anexos, lixeira)** | pronta no código, aguardando revisão    |
| 3. Visões (lista, quadro, calendário, tabela, linha do tempo)     | pronta no código                        |
| **4. Tarefas e colaboração**                                      | **próxima**                             |
| 5. Automações                                                     | a fazer                                 |
| 6. Painéis e relatórios                                           | a fazer                                 |
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

### O que os testes provam (377 testes)

| Arquivo                                    | O que garante                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/test/*.test.ts` (28)      | resolução de acesso e regra "ninguém concede o que não tem"; o que cada tipo de campo aceita como configuração e como valor; nome de arquivo sem nada que vire caminho; só tipos inofensivos são mostrados na página; segredo nunca anda com os valores comuns e é guardado exatamente como digitado                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/test/auth.test.ts` (22)          | instalação fechada sem o token; 2º fator obrigatório; código de uso único; dispositivo novo sem sessão até aprovação; convite de uso único; força bruta bloqueada; sessão revogada ou conta suspensa cai na hora; origem cruzada e subdomínio irmão recusados                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api/test/authorization.test.ts` (20) | pela API: funcionário A não vê nem altera nada do B; ADM sem concessão não vê nada; ADM não concede fora da própria área nem para iguais ou superiores; ninguém se promove; lista sensível exige 2º fator; o 2º fator pode ser confirmado depois de um tempo parado; o último Dono não pode ser rebaixado                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api/test/database.test.ts` (24)      | direto no banco, com as credenciais da API e sem código da API: as mesmas garantias; identidade não pode ser forjada nem sobrevive à transação; quem só pode ver uma lista não altera nada nela nem move itens para dentro ou para fora; credenciais inalcançáveis; auditoria não pode ser editada nem apagada; adulteração com acesso total é detectada; toda tabela tem RLS; nenhuma função aberta a `PUBLIC`                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/crypto.test.ts` (16)        | argon2id com sal novo; cifra autenticada presa à linha e à finalidade; resumo com chave para códigos de recuperação; tokens de 256 bits; TOTP sem repetição; segredos com permissão `0600` e nunca sobrescritos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/stages.test.ts` (21)        | pela API e direto no banco: item sempre em uma etapa da própria lista; lista nunca sem etapa; só quem gerencia altera etapas; funcionário move só o que é dele; o histórico de etapas não pode ser escrito nem apagado pela aplicação; etapa em uso não some sem destino; item criado por quem só vê os seus nasce atribuído a quem criou                                                                                                                                                                                                                                                                                                                                                                                                         |
| `apps/api/test/fields.test.ts` (30)        | pela API e direto no banco: só quem gerencia a lista muda os campos; valores seguem o item (lidos por quem o vê, escritos por quem o edita, e por mais ninguém); valor que não cabe no tipo é recusado nas duas camadas, e as duas concordam; tipo, lista e origem de um campo não mudam; opção e campo são arquivados, nunca apagados; valor de campo arquivado ou de lista que o item deixou fica fora de alcance; cópia só pode se dizer "o mesmo campo" de um campo que a pessoa vê                                                                                                                                                                                                                                                           |
| `apps/api/test/history.test.ts` (12)       | pela API e direto no banco: toda mudança entra no histórico com autor, antes e depois, por qualquer caminho; salvar sem mudar nada não acrescenta linha; ninguém escreve, corrige ou apaga o histórico, nem um Dono, nem o dono do banco; funcionário lê só a história dos próprios itens; o passado de um campo arquivado ou deixado em outra lista não é lido                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/trash.test.ts` (11)         | pela API e direto no banco: item na lixeira some da lista de todos e aparece só na lixeira de quem o via; só quem edita manda e traz de volta; nada nele nem no que pende dele muda; a data e quem mandou são escritas pelo banco; ninguém remove item, só a limpeza depois de 30 dias, que leva tudo junto e fica na auditoria                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/move.test.ts` (9)           | pela API e direto no banco: só quem edita o item e a lista de destino move; o item cai na etapa certa e o histórico registra; vão junto só os valores de campos de mesma origem que significam o mesmo lá (não opção que não existe, não dinheiro em outra moeda, não campo arquivado); o que fica volta com o item; nada é escrito numa lista para onde a pessoa não poderia mover                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/test/stage-sets.test.ts` (4)     | aplicar um conjunto cria o que falta, ajusta o que tem o mesmo nome, põe o conjunto primeiro e não tira nem move nada; todos os modelos prontos são aceitos; só quem gerencia a lista aplica; conjunto malformado ou acima do limite é recusado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/account.test.ts` (9)        | trocar a senha exige a senha atual e um código, encerra as outras sessões na hora e fica no registro; senha ou código errado é recusado do mesmo jeito e contado; nova senha segue as regras e não repete a atual; cada um vê e encerra só as próprias sessões; só quem distribui trabalho na lista vê quem pode recebê-lo; banco recusa passar item para quem não pode editar a lista, para quem só vê, ou para conta suspensa                                                                                                                                                                                                                                                                                                                   |
| `apps/api/test/people-field.test.ts` (6)   | pela API e direto no banco: o campo só nomeia quem pode editar a lista (nem quem só vê, nem quem não tem acesso); quem perdeu o acesso continua onde estava, mas não volta depois de sair; ao mover, só vai junto se todos puderem trabalhar lá; banco e API concordam sobre o formato                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `apps/api/test/attachments.test.ts` (23)   | pela API e direto no banco: o arquivo volta byte a byte como foi enviado; o envio continua de onde parou; no disco só há ruído sem nome, e conteúdo alterado ou trocado é recusado; nada sai antes do antivírus, nem quando ele está fora do ar, e ele só é chamado depois que o envio foi gravado de vez; infectado fica bloqueado com alerta; anexo segue o item (colega e quem não tem acesso não veem nem o nome); envio é só de quem começou até terminar; lista sensível pede o código e registra cada download; só imagem, áudio e vídeo aparecem na página, e trechos de áudio e vídeo chegam sem baixar tudo; lixeira de 30 dias, depois o conteúdo é apagado; ninguém marca arquivo como verificado, muda o resumo ou forja quem enviou |
| `apps/api/test/secret-field.test.ts` (14)  | pela API e direto no banco: o valor fica cifrado, fora de toda lista e do histórico; a API não consegue ler a coluna cifrada; revelar exige ver o item, a capacidade de revelar e código recente, e cada revelação fica no registro; quem só vê não troca; nada muda na lixeira; o segredo fica na lista de origem quando o item muda de lista e volta com ele; valor copiado para outra linha não abre; quem trocou por último é escrito pelo banco                                                                                                                                                                                                                                                                                              |
| `apps/api/test/files-field.test.ts` (4)    | pela API e direto no banco: o campo só nomeia anexos do próprio item, prontos e fora da lixeira, nem pelo dono do banco; o que já estava nomeado pode ficar, mas não volta depois de sair; ao mudar de lista leva só o que ainda está anexado, e sem nada anexado o valor fica para trás em vez de travar a mudança                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/test/structure.test.ts` (4)      | quem gerencia um espaço ou uma pasta, sem ser Dono, cria pastas e listas ali e em nenhum outro lugar, e não cria espaços; quem só trabalha numa lista não cria nada em volta dela; a árvore diz a cada pessoa onde ela pode criar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/api/test/views.test.ts` (6)          | pela API e direto no banco: cada pessoa lê, cria, renomeia e apaga só as próprias visões, nem colega, gestor ou Dono alcança as dos outros, nem com comandos que não apontam uma linha; só para listas que a pessoa abre, e quem perde o acesso perde as visões junto; só texto de endereço é aceito; nomes não se repetem; no máximo 30 por lista                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/order.test.ts` (4)          | pela API e direto no banco: a ordem da coluna fica como foi dada, sem mudar a "última mudança" nem o histórico; item que muda de etapa vai para o fim; tudo ou nada quando há um item que a pessoa não pode editar ou de outra etapa; quem só vê não ordena                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api/test/search.test.ts` (5)         | a busca acha só o que cada pessoa abriria (funcionário só os seus, quem não tem acesso nada), sem diferença de acentos e com todas as palavras; acha na descrição depois dos títulos; lista sensível sem código recente e lixeira ficam de fora; o que é digitado vale literalmente                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/test/bulk.test.ts` (5)           | pela API e direto no banco: mudar vários itens é tudo ou nada, só com o que a pessoa pode mudar; passar vários só por quem distribui trabalho e só para quem pode trabalhar na lista; vários para a lixeira exigem a capacidade e código recente, ficam no registro e alertam os Donos; no banco, mandar um por vez na mesma requisição conta junto; um só continua como o botão do item                                                                                                                                                                                                                                                                                                                                                          |
| `apps/api/test/scale.test.ts` (2)          | uma lista de 500 itens com 8 campos abre em bem menos de um segundo para Dono, gestor e funcionário, e continua mostrando a cada um só o que é seu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api/test/web.test.ts` (9)            | a página vem com a política que proíbe código embutido e de outras origens; nenhum arquivo de fora da pasta, oculto ou de tipo desconhecido é servido; endereços da API nunca respondem com a página; a API continua recusando outras origens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/web/test/*.test.ts` (89)             | a página compilada só carrega arquivos próprios, sem nada embutido; mensagens de erro nunca mostram detalhe técnico; durações e datas escritas por extenso; números, dinheiro e datas lidos e digitados como se escreve em português; um valor guardado só vira link se o endereço for seguro de abrir; um arquivo de etapas exportado é lido de volta igual, e qualquer outro é recusado com uma frase; cada linha do histórico vira uma frase, sem nomear pessoa ou lista que quem lê não pode ver; o envio de arquivo manda só as partes que faltam, tenta de novo quando a conexão cai, desiste quando o servidor recusa e para quando a pessoa cancela                                                                                       |

**Percurso em navegador real** (`apps/web/e2e`, 27 passos, job "Percurso em navegador real" no CI):
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
vê a escolha de responsáveis; campo de pessoas preenchido pela Dona e só lido pela funcionária; imagem e texto anexados pelo celular, imagem mostrada na página, texto só baixado e recebido no computador idêntico ao enviado, anexo removido e restaurado e tudo isso no histórico; senha guardada pela funcionária, que não consegue lê-la de volta, e revelada pela Dona só depois do código; campo de arquivos que oferece só os anexos do item; funcionária que passa a gerenciar o espaço cria uma lista nele, sem poder criar espaços; quadro com cartão arrastado de uma coluna para outra, que continua lá depois de recarregar, movido de volta pelo menu de etapa, aberto numa janela, e no celular só o quadro rola de lado; cartão posto à mão uma posição acima, ordem mantida depois de recarregar; lista filtrada pelo título e por valor digitado como se escreve aqui, ordenada por um campo, filtro mantido depois de recarregar e no quadro, salvo como visão com nome e trazido de volta num toque; lista agrupada por responsável e pelas opções de um campo; calendário com o item no dia de hoje, aberto numa janela, navegação entre meses e, no celular, só os dias com itens; tabela ordenada pelo clique na coluna, colunas escolhidas que voltam depois de recarregar, etapa mudada na célula; busca no alto da página que leva à lista já filtrada; linha do tempo com a barra no dia certo, semanas para a frente e de volta para hoje; dois itens selecionados movidos de etapa e passados para a funcionária de uma vez, e mandados juntos para a lixeira só depois do código; Dona troca a própria senha e continua conectada; lista sensível
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
Nas regras de anexos foram 23 enfraquecimentos: 22 derrubam ao menos um teste (quatro só depois
de testes novos: concluir o envio de outra pessoa, mexer nas partes de um envio já concluído, ler
as partes de um arquivo alheio e alterar o que um arquivo foi ao ser enviado, até pelo dono do
banco). O que sobra é redundante por desenho: gravar partes de um envio alheio já é barrado porque
o envio de outra pessoa nem aparece para quem tenta.
No campo secreto foram 16 enfraquecimentos, todos derrubam testes (três só depois de testes
novos: quem trocou por último, revelar sem ver o item tendo a capacidade, e quem só vê gravando
onde ainda não há valor).
No campo de arquivos foram 7 enfraquecimentos, todos derrubam testes.
Na ordem à mão foram 3, todos derrubam testes. Na lixeira em massa foram 5, todos derrubam testes. Nas visões salvas foram 6, todos derrubam testes (três só depois de testes com comandos que não
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
- `pnpm audit` aponta 1 aviso de severidade moderada (`minimatch`, via `eslint`, só em
  desenvolvimento; não entra no que roda em produção). O CI barra a partir de severidade alta.

## Próximo passo exato

1. **Fase 4 — tarefas e colaboração**, nesta ordem: prioridade e prazo nativos do item;
   subtarefas; checklist; comentários; menções com @; recorrência; notificações na tela e push;
   atualização em tempo real.
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
