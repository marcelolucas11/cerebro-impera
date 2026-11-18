# Decisões técnicas

Cada decisão registra o que foi escolhido e por quê. Quando segurança e conveniência divergem, a
escolha é segurança, e fica anotada aqui.

## D1 — A identidade de quem pede é fixada dentro do banco

**Decisão.** A API não diz ao banco "sou o usuário X". Ela entrega o resumo do token de sessão a
`authz.begin_request`, e é o banco que confere sessão, conta e dispositivo e amarra a transação à
pessoa (tabela `authz.request_ctx`, que o papel da aplicação não consegue escrever). As políticas de
row-level security leem essa amarração.

**Por quê.** O caminho comum (uma variável de sessão como `app.user_id`) pode ser definido pelo
próprio papel da aplicação: uma única injeção de SQL bastaria para se declarar Dono. Aqui, mesmo
com SQL arbitrário, o atacante só é quem tiver um token de sessão válido. A amarração vale para uma
transação e é esquecida ao fim dela.

_Diverge do plano inicial (`app.user_id` por transação) por ser mais forte._

## D2 — SQL direto e migrações em arquivos, sem ORM

**Decisão.** Migrações são arquivos `.sql` numerados; as consultas usam `pg` com um marcador `sql`
que transforma todo valor interpolado em parâmetro. Uma migração aplicada não pode ser editada (o
migrador confere o checksum).

**Por quê.** O modelo de segurança mora no banco: políticas de RLS, gatilhos de guarda, funções
`SECURITY DEFINER`, privilégios por coluna. Um ORM não expressa isso e esconderia a parte que mais
precisa de revisão. _Diverge do plano inicial (Drizzle)._

## D3 — Dois papéis de banco, nenhum deles dono de nada

**Decisão.** `cerebro_app` atende requisições autenticadas e só enxerga o que a RLS permite para a
pessoa da requisição. `cerebro_auth` atende o login e só alcança tabelas de credenciais. Nenhum é
dono de objetos, superusuário ou `BYPASSRLS`. As migrações rodam com um terceiro usuário, que a API
nunca usa.

**Por quê.** Uma falha num endpoint de dados não lê hashes de senha nem fabrica sessões; uma falha
no login não lê dados da empresa.

## D4 — Duas implementações independentes da mesma regra

**Decisão.** As regras de acesso existem em TypeScript (`packages/shared`, usadas pela API) e em
SQL (`authz.*`, usadas pela RLS). Os testes atacam cada camada separadamente:
`authorization.test.ts` pela API e `database.test.ts` direto no banco, com as credenciais da API.

**Por quê.** Com uma camada só, um erro vaza dado. Com duas implementações escritas separadamente,
o mesmo erro teria de ser cometido duas vezes.

## D5 — O que a pessoa não pode ver "não existe"

**Decisão.** Recurso inexistente e recurso oculto respondem igual (404). 403 só aparece para algo
que a pessoa já vê mas não pode alterar.

**Por quê.** Respostas diferentes permitiriam mapear o que existe (nomes de clientes, listas).

## D6 — O papel não abre dados; concessões abrem

**Decisão.** Só o Dono vê tudo. ADM, Gestor e Funcionário começam sem acesso e recebem concessões
por espaço, pasta ou lista (`nenhum | ver | comentar | editar | gerenciar`), valendo a mais
específica. Cada concessão diz também se a pessoa vê todos os itens ou só os seus (padrão para
Funcionário). Capacidades (gerenciar usuários, aprovar dispositivos, ver auditoria…) são dadas
somente por Donos.

**Por quê.** "ADM vê só o que for concedido" e "funcionário vê só o que é dele" são requisitos
centrais. Um "nenhum" explícito numa lista a esconde mesmo dentro de um espaço concedido.

## D7 — Ninguém concede o que não tem

**Decisão.** Quem não é Dono só concede acesso num escopo que gerencia por inteiro, só para pessoas
abaixo de si na hierarquia, nunca para si mesmo, e não amplia a visibilidade de itens além da
própria. Toda mudança de permissão exige segundo fator recente, é auditada por gatilho e, se feita
por quem não é Dono, gera alerta para os Donos.

## D8 — Trilha de auditoria: só acrescenta, e denuncia adulteração

**Decisão.** `audit.log` não aceita UPDATE, DELETE nem TRUNCATE: os papéis da API não têm o
privilégio e gatilhos recusam até o dono do banco. Cada entrada guarda o hash da anterior;
`audit.verify_chain()` recalcula tudo e aponta a primeira quebra.

**Por quê.** Quem tem acesso total ao servidor pode desligar gatilhos. A cadeia de hash não impede
isso, mas torna a adulteração detectável. **Limite conhecido:** quem controla o banco inteiro pode
recalcular a cadeia. A defesa completa virá com a âncora externa do hash mais recente nos backups
(Fase 9).

## D9 — Segredos de sessão nunca ficam guardados

**Decisão.** Tokens (sessão, dispositivo, convite, desafio) têm 256 bits aleatórios. A API envia ao
banco o SHA-256 do token e o banco guarda o SHA-256 disso. Cookies usam o prefixo `__Host-`
(`Secure`, `HttpOnly`, `SameSite=Strict`, sem `Domain`).

**Por quê.** Um dump do banco ou um log não contém nada reaproveitável. O prefixo `__Host-` prende
o cookie ao host exato: outros sistemas em subdomínios irmãos do mesmo domínio não o leem nem o
sobrescrevem.

## D9b — Códigos de recuperação com resumo chaveado

**Decisão.** Os códigos de recuperação (cerca de 49 bits cada) são guardados como HMAC com uma
chave derivada da chave da instância e atrelados à pessoa.

**Por quê.** São curtos o bastante para serem adivinhados offline se o banco vazar. Com a chave
fora do banco, uma cópia do banco sozinha não permite testá-los.

## D10 — Subdomínios irmãos são tratados como terceiros

**Decisão.** Toda requisição que altera estado precisa trazer o `Origin` exato da instalação, e
qualquer requisição que o navegador marque como vinda de outra origem (`Sec-Fetch-Site`) é
recusada. Só JSON é aceito.

**Por quê.** Para o navegador, `a.exemplo.com` e `b.exemplo.com` são o "mesmo site":
`SameSite=Strict` sozinho não impede que um sistema vizinho comprometido forje requisições.

## D11 — Segundo fator obrigatório, dispositivo aprovado, confirmação para ações críticas

**Decisão.** TOTP (SHA-1, 6 dígitos, 30 s, o que os aplicativos autenticadores suportam) é
obrigatório para todos; cada código vale uma única vez. Um navegador novo não recebe sessão até
alguém com autoridade aprovar. Ações críticas (permissões, usuários, aprovar dispositivo, abrir
lista sensível) exigem o segundo fator confirmado nos últimos 15 minutos (configurável).

**Por quê.** Limita o que uma senha vazada e o que uma sessão sequestrada conseguem fazer.

## D12 — Nenhum segredo ou padrão no código

**Decisão.** `init-secrets` gera no servidor a chave da instância e as senhas do banco (arquivo
`0600`, nunca sobrescrito). O assistente de primeira instalação só abre com um token escrito num
arquivo do servidor e se fecha para sempre depois do primeiro Dono.

**Por quê.** O repositório é público: qualquer padrão seria conhecido por todos.

## D13 — Cadeia de fornecimento

**Decisão.** Scripts de instalação de pacotes bloqueados por padrão; só entram versões publicadas
há pelo menos 3 dias; lockfile congelado; actions do GitHub fixadas por SHA de commit com
permissões mínimas; ferramentas baixadas no CI têm versão fixa e checksum conferido; auditoria de
dependências, CodeQL e Scorecard no CI.

**Por quê.** Qualquer instalação atualizará a partir deste repositório. Comprometer o repositório
ou uma dependência seria comprometer todas elas.

## D14 — Nada é apagado de verdade nesta fase

**Decisão.** A aplicação não tem privilégio de DELETE em usuários, espaços, pastas, listas e itens.
Arquivamento e lixeira com prazo chegam na Fase 2.

## D15 — Licença AGPL-3.0-only

**Decisão.** Padrão do projeto, sujeito à confirmação do mantenedor. Quem oferecer o sistema como
serviço precisa abrir as próprias modificações.

## D16 — Idioma

Código, identificadores e comentários em inglês; documentação e interface em português (com
internacionalização prevista).

## D17 — A própria API serve a página, a partir da memória

**Decisão.** A página compilada (`apps/web/dist`) é lida uma vez na inicialização para uma tabela
fixa de endereços exatos. Uma requisição só pode escolher uma entrada dessa tabela: nenhum caminho
vindo da rede é resolvido no sistema de arquivos. Arquivos ocultos, atalhos e tipos desconhecidos
ficam de fora. Sem dependência extra para servir arquivos.

**Por quê.** Uma origem só (página e API), sem regra de proxy para errar, e sem a classe inteira de
falhas de "sair da pasta". _Diverge do desenho inicial (contêiner `web` separado) por ser mais
simples e mais fechado._

## D18 — A página não executa nada que não seja dela

**Decisão.** A página é servida com uma política (CSP) que só permite scripts, estilos, fontes e
requisições da própria origem: nada embutido, nada de fora, nunca em moldura, e formulários nunca
enviados pelo navegador por conta própria. As fontes vão empacotadas junto. A página pode ser
aberta por um link vindo de qualquer lugar (um convite clicado no e-mail precisa funcionar); a API
continua recusando requisições de outras origens.

**Por quê.** Se um texto malicioso chegar à tela (um nome, um comentário), a política impede que
ele vire código. O token de convite viaja depois do `#` do endereço, parte que o navegador nunca
envia ao servidor, então não aparece em logs nem em proxies.

## D19 — Interface: tipografia e cores a serviço da leitura

**Decisão.** Uma família tipográfica desenhada para não confundir caracteres parecidos (I, l, 1,
O, 0), porque a ferramenta é feita de nomes, códigos e status lidos o dia todo. Fundo escuro em
ardósia, um único tom de destaque para a ação principal e a etapa atual, verde e vermelho só para
estados. Todas as cores e fontes são variáveis: uma instalação white label troca os valores, não as
regras. O roteador de telas entra junto com a navegação por espaços (Fases 2 e 3); até lá as telas
de entrada são uma máquina de estados simples.

## D20 — Etapas pertencem à lista, e o tempo em cada etapa é escrito pelo banco

**Decisão.** Cada lista tem as próprias etapas (nome, cor, ordem e um significado entre "a fazer",
"em andamento", "concluído" e "encerrado"). O item aponta para a etapa por uma chave que inclui a
lista, então um item nunca fica em etapa de outra lista. Uma lista nunca fica sem etapa. A entrada
e a saída de cada etapa são gravadas por gatilho do banco; a aplicação não tem privilégio para
escrever, corrigir ou apagar esse histórico, nem para definir "desde quando" o item está na etapa.

**Por quê.** O nome da etapa é livre (cada área usa as suas), mas relatórios precisam saber o que
conta como aberto ou concluído; o significado resolve isso sem engessar os nomes. E o tempo em
cada etapa só serve para cobrar e medir se ninguém puder reescrevê-lo.

## D21 — Quem só vê os próprios itens é responsável pelo que cria

**Decisão.** Quando alguém cujo acesso à lista é "só os itens atribuídos a mim" cria um item, o
banco o atribui a essa pessoa no mesmo instante.

**Por quê.** Sem isso o item some da tela de quem acabou de criar, e a pessoa cria de novo. A regra
fica no banco para valer por qualquer caminho (tela, automação, importação).

## D22 — Confirmação do 2º fator fora da transação da requisição

**Decisão.** A rota que confirma o 2º fator primeiro identifica quem pede, encerra essa transação
e só então chama o serviço de login. Todas as conexões têm limite de espera por trava (5 s).

**Por quê.** Toda requisição autenticada atualiza a linha da sessão. O serviço de login, por outra
conexão, atualizava a mesma linha enquanto a primeira transação ainda estava aberta: uma esperava
a outra dentro da mesma requisição, e a confirmação travava. O limite de espera garante que um erro
parecido no futuro falhe rápido e apareça nos testes, em vez de segurar conexões.

## D23 — Campos pertencem à lista; cópias guardam a origem; nada é apagado

**Decisão.** Cada lista define os próprios campos. Copiar um campo para outra lista cria um campo
novo que guarda a origem do primeiro; uma lista tem cada origem no máximo uma vez. Tipo, lista e
origem de um campo nunca mudam. Campos e opções de escolha são arquivados, não apagados: somem da
tela e de qualquer leitura feita pela aplicação, e voltam com tudo o que tinham ao serem
restaurados. A escala de uma nota é fixa.

**Por quê.** O plano previa campos por espaço, pasta ou lista. Campos só por lista, com cópia que
preserva a origem, dão o mesmo resultado para relatórios entre listas (dá para somar "o mesmo
campo" em listas de espaços diferentes) com uma regra de acesso só: quem gerencia a lista. E
apagar um campo seria apagar uma coluna inteira de trabalho com um clique. _Diverge do plano
inicial; herança por espaço e pasta pode ser acrescentada depois sem quebrar nada._

## D24 — O valor de um campo é conferido na API e no banco, e as duas regras são comparadas

**Decisão.** O que cada tipo aceita está escrito duas vezes: em TypeScript (para a tela e a API
explicarem o erro) e em SQL (gatilho que vale para qualquer caminho de escrita). Um teste passa a
mesma tabela de casos pelas duas e exige a mesma resposta. Dinheiro é guardado em centavos
inteiros; data como dia do calendário, sem fuso; data e hora como instante exato.

**Por quê.** Importações, automações e a migração vão escrever valores sem passar pela tela. Um
valor torto guardado hoje vira relatório errado amanhã. Duas regras escritas à mão divergem com o
tempo; o teste de comparação é o que as mantém iguais.

## D25 — Regras de leitura calculadas uma vez por consulta

**Decisão.** As regras que decidem quem lê itens, responsáveis, histórico, etapas, campos e
valores perguntam "a lista desta linha está entre as listas que a pessoa pode ler?", e esse
conjunto é calculado uma única vez por consulta. O que depende de um item (responsáveis, histórico,
valores) consulta o próprio item, e assim herda a regra dele em vez de repeti-la. As regras de
escrita continuam conferindo linha a linha. A compilação de consultas em tempo de execução (JIT)
fica desligada para os usuários da aplicação.

**Por quê.** A primeira versão chamava uma função por linha: abrir uma lista de 500 itens com 8
campos levava cerca de 2 segundos. Medido depois da mudança: cerca de 30 milissegundos, com 20 mil
itens e 160 mil valores no banco. O JIT só acrescentava um atraso fixo de 0,2 segundo às consultas
maiores. As regras antigas e as novas foram conferidas pelos mesmos testes e por enfraquecimento
proposital de cada condição.

## D26 — O histórico do item é escrito pelo banco e só lido pela aplicação

**Decisão.** Cada mudança em um item (criação, título, descrição, etapa, lista, responsáveis e
valores de campos) vira uma linha gravada por gatilho, com autor, valor de antes e de depois. A
aplicação tem só leitura. Gatilhos recusam alterar ou apagar uma linha, inclusive para o dono do
banco; as linhas só somem junto com o item, quando ele for removido de vez (ver lixeira). Quem lê o
item lê a história inteira, inclusive o que aconteceu antes de ele chegar à pessoa. O passado de um
campo segue a regra do campo: arquivado ou deixado em outra lista, não é lido.

**Por quê.** Delegar com segurança exige saber quem mudou o quê, sem depender de cada tela lembrar
de registrar, e sem que alguém com acesso amplo apague o próprio rastro. O registro de auditoria
já cobre ações de segurança; este cobre o trabalho do dia a dia e é lido por quem trabalha no item.

## D27 — Lixeira de 30 dias, e nenhuma outra forma de remover um item

**Decisão.** Quem pode editar um item pode mandá-lo para a lixeira e trazê-lo de volta. Na
lixeira o item some de listas e contagens, e nada nele (nem responsáveis, nem campos) muda, exceto a
etapa quando a etapa dele é removida da lista. Depois de 30 dias ele é removido de vez, junto com
valores, responsáveis e histórico. A aplicação não tem permissão para remover itens: só a função
do banco que limpa a lixeira, com o prazo escrito nela, e que fica no registro de auditoria. A data
de envio e quem enviou são escritos pelo banco; nem o dono do banco altera essa data sem desligar
a proteção. Sem o 2º fator recente, os itens de uma lista sensível ficam fora de alcance também
para mandar à lixeira.

**Por quê.** Apagar por engano é o erro mais caro e o mais comum; 30 dias dão tempo de perceber.
Com o prazo só no banco, nenhuma falha da aplicação apaga algo antes da hora. _Rever com o
mantenedor:_ hoje um funcionário pode mandar para a lixeira os próprios itens (como no ClickUp). Fica
registrado no histórico e o Dono vê e restaura; se preferir, dá para exigir "gerenciar" na lista.

## D28 — Ao mudar de lista, vai junto só o que significa o mesmo do outro lado

**Decisão.** Mover um item exige poder editá-lo onde está e poder editar na lista de destino. Um
valor vai junto quando a outra lista tem o mesmo campo (cópia de mesma origem e mesmo tipo), o
campo está em uso nas duas, e o valor significa o mesmo lá: a opção existe lá, e dinheiro está na
mesma moeda. O resto fica guardado no item, invisível, e volta se o item voltar. A regra está num
gatilho do banco, então vale para qualquer caminho. Responsáveis continuam os mesmos; quem não
tem acesso à lista de destino deixa de ver o item.

**Por quê.** Converter moeda ou adivinhar a opção equivalente seria inventar dado. Guardar o que
não cabe, em vez de apagar, deixa a mudança de lista sem perda.

## D29 — Modelos de etapas: genéricos no código, os da empresa em arquivo

**Decisão.** O código traz só modelos genéricos (tarefas, tarefas com revisão, clientes,
aprovação). Os conjuntos de cada empresa são exportados como arquivo e importados onde for
preciso, ou copiados de outra lista. Aplicar um conjunto cria as etapas que faltam e ajusta cor e
significado das que têm o mesmo nome; nunca remove etapa e nunca muda item de etapa. Não há tabela
de modelos no banco.

**Por quê.** Repositório público não pode carregar a forma de trabalhar de uma empresa. Arquivo e
cópia entre listas resolvem o reuso sem mais uma coisa com regra de acesso própria; e aplicar sem
remover nada torna o botão seguro de apertar. Remover continua sendo no editor, escolhendo para
onde vão os itens.

## D30 — Item só vai para quem pode trabalhar nele; a lista de pessoas é de quem distribui

**Decisão.** Um item só é passado para uma conta ativa que pode editar a lista dele; a regra está
num gatilho do banco. Quem distribui trabalho numa lista (edita todos os itens dela) vê os nomes
de quem pode recebê-lo, sem precisar da capacidade de gerenciar usuários. Quem só vê os próprios
itens não vê essa lista e não escolhe responsáveis.

**Por quê.** Passar um item para quem não enxerga a lista não serve a ninguém e esconde trabalho.
E um gestor precisa delegar sem ganhar acesso ao cadastro de pessoas inteiro.

## D31 — Trocar a própria senha pede a senha atual e um código, e derruba as outras sessões

**Decisão.** A troca pede a senha atual e um código novo do autenticador; o código só é gasto se a
senha estiver certa. Erro de qualquer um dos dois recebe a mesma resposta e conta para o bloqueio
do aparelho. Ao trocar, todas as outras sessões da pessoa terminam; a atual continua.

**Por quê.** Quem troca a senha costuma desconfiar de que alguém a conhece: as outras sessões
precisam cair na hora. Exigir o código impede que alguém com o computador aberto e destrancado
troque a senha e tome a conta.

## D32 — Campo de pessoas segue a regra de delegar

**Decisão.** Um campo de pessoas só nomeia quem pode editar a lista do item, conferido por
gatilho no banco. Quem já foi nomeado continua se perder o acesso, como uma opção arquivada.
Nomes só aparecem para quem já os vê (quem gerencia pessoas ou distribui trabalho na lista); os
demais veem "você" ou "outra pessoa".

**Por quê.** É a mesma pergunta de passar um item para alguém, então a resposta é a mesma. E o
campo não pode virar um jeito de um funcionário descobrir quem são os colegas.

## D33 — Anexos: volume próprio, cifrados por segmento, sem link público

**Decisão.** O desenho completo está em `docs/design/anexos.md`. Em resumo: arquivos num volume
da instalação, fora do banco, com nome aleatório; cada arquivo com chave própria guardada cifrada
pela chave da instância; conteúdo em segmentos de 8 MiB com AES-256-GCM, que servem também ao
envio retomável; baixar só com a sessão normal, sempre com `nosniff` e `sandbox`, e
pré-visualização só para tipos que não executam nada; anexo segue as permissões do item; nada é
apagado antes de 30 dias.

**Pendente (mantenedor):** antivírus. Proposta: ClamAV na mesma VPS, se houver de 1,2 a 1,5 GB de
memória livre. Até lá, o verificador é uma peça trocável e os testes usam um falso. Sem escolha
feita (`CEREBRO_ANTIVIRUS` vazio), os anexos ficam desligados: nunca se liga "sem antivírus" por
omissão.

**Construído assim:** PDF só como download por enquanto (o leitor do navegador não roda sob
`sandbox`); a tela consulta o anexo pela lista antes de abrir ou baixar, para uma lista sensível
pedir o código em vez de responder "não encontrado"; envio interrompido continua escolhendo o
mesmo arquivo, mesmo depois de fechar a página; antivírus fora do ar deixa o arquivo em
verificação e ele é entregue de novo a cada hora.

**Por quê.** Um serviço de arquivos à parte (MinIO, como previa o plano) seria mais um contêiner,
mais uma senha e mais uma porta para proteger, sem ganho para 20 pessoas. A API já autentica e já
sabe quem pode ver cada item; servir os arquivos por ela mantém uma regra só. _Diverge do plano
inicial (MinIO e links pré-assinados)._

## D34 — Campo secreto: guardado à parte, revelado um por vez, cada revelação no registro

**Decisão.** Um tipo de campo novo, "secreto", para senhas, chaves de acesso e dados que ninguém
deve ler por cima do ombro.

- O valor é cifrado pela API com a chave da instância (o mesmo cofre do 2º fator), preso ao item
  e ao campo, e guardado numa tabela própria, nunca junto dos outros valores. A API não tem
  permissão de ler a coluna cifrada: o único caminho é a função do banco que revela.
- Revelar pede três coisas: ver o item, ter a capacidade "Revelar campos secretos" (os Donos têm
  todas; os demais só se um Dono der) e 2º fator recente, em qualquer lista, não só nas
  sensíveis. Um valor por vez, e cada revelação entra no registro de auditoria com quem, qual item
  e qual campo. Quem edita o item preenche, troca ou apaga sem precisar ver o valor.
- Listas, quadros e o histórico mostram só que existe um valor ("preenchido", "trocado",
  "apagado"), nunca o valor, nem cifrado.
- Na tela, o valor revelado some sozinho depois de 30 segundos e pode ser copiado sem aparecer.
- Item que muda de lista não leva o segredo; ele fica guardado e volta se o item voltar (mesma
  regra dos outros campos que não significam o mesmo do outro lado). Item na lixeira não revela.

**Por quê.** Guardar o segredo junto dos outros valores faria ele aparecer cifrado em toda
leitura de lista e no histórico, e a API poderia abri-lo sem deixar rastro. Separado, sem
permissão de leitura direta, toda revelação passa pelo banco e fica registrada, mesmo se a API
tiver uma falha. _Rever com o mantenedor:_ um alerta para os Donos quando alguém revela muitos
segredos em pouco tempo (hoje fica só no registro).

## D35 — Campo de arquivos: aponta para anexos do próprio item

**Decisão.** Um tipo de campo "arquivos" que diz qual anexo é qual ("contrato assinado", "nota
fiscal"). Os arquivos continuam sendo os anexos do item, com todas as regras deles (antivírus,
cifragem, lixeira, quem baixa); o campo guarda só a lista de quais anexos, até 20.

- Só pode nomear anexos do mesmo item, que já terminaram de chegar e não estão na lixeira. O
  banco confere em qualquer caminho, até para o dono do banco.
- O que já estava nomeado pode ficar, mesmo depois de o anexo ir para a lixeira (como uma opção
  arquivada); só não pode ser nomeado de novo enquanto estiver lá.
- Ao mudar de lista, o valor vai junto só com os anexos que ainda estão no item; se não sobrar
  nenhum, o valor fica para trás em vez de impedir a mudança.

**Por quê.** Um segundo lugar para guardar arquivos dobraria as regras de acesso, antivírus e
lixeira. Apontar para os anexos mantém uma regra só e deixa o campo útil para filtrar e ordenar
nas visões da Fase 3.

## D36 — Quadro: arrastar sem biblioteca, menu de etapa para o teclado

**Decisão.** A primeira visão da Fase 3 é o quadro (kanban): uma coluna por etapa, um cartão por
item, em `/listas/:id/quadro`, ao lado da visão em lista.

- Arrastar usa os eventos de ponteiro do próprio navegador (mouse, dedo e caneta), pela alça do
  cartão, sem dependência nova. A alça não rola a tela; o resto do quadro rola de lado no celular,
  e perto da borda o quadro rola sozinho enquanto o cartão é arrastado.
- O cartão muda de coluna na hora e volta se o servidor recusar (a mesma regra de quem pode mover
  vale aqui: funcionário só move o que é dele).
- Teclado e leitor de tela movem pelo menu de etapa de cada cartão; a mudança é anunciada.
- Dentro de cada coluna, a ordem é a que a equipe deu à mão (D41); cartões nunca posicionados vêm
  depois, quem está há mais tempo na etapa primeiro.
- Abrir um cartão mostra o item inteiro numa janela sobre o quadro, com o mesmo painel da lista.

**Por quê.** Bibliotecas de arrastar e soltar trazem dezenas de dependências para algo que o
navegador já faz; os eventos de ponteiro funcionam igual em computador, iPad e celular. O menu de
etapa garante que ninguém dependa de arrastar.

## D37 — Filtrar e ordenar na própria página, guardado no endereço

**Decisão.** Busca no título, responsável, etapa, uma condição por campo e a ordem são aplicados
pela página sobre os itens que a pessoa já recebeu, e ficam no endereço (`?busca=…&ordem=…`), de
modo que recarregar, trocar entre lista e quadro ou mandar o link mantém o recorte.

- Um filtro só esconde; nunca pede ao servidor nada além do que a pessoa já vê. Campo secreto se
  filtra só por "preenchido" ou "vazio".
- Endereço com valores sem sentido é ignorado, nunca dá erro.
- A ordem padrão é a "ordem do quadro" (D41).
- A lista também agrupa por responsável, por um campo ou sem grupos (`agrupar=`); um item com
  várias pessoas ou marcadores aparece em cada grupo. Item novo só se cria no agrupamento por
  etapa, que diz em que etapa ele entra.

**Por quê.** Uma lista de até alguns milhares de itens já chega inteira em bem menos de um segundo
(teste de escala); filtrar no servidor seria mais um caminho de consulta para proteger, sem ganho
para uma equipe deste tamanho. Se um dia as listas crescerem muito, a mesma descrição de filtro
pode ir para a API.

## D38 — Visões salvas são de cada pessoa, e só guardam o endereço

**Decisão.** Uma visão salva é um nome para uma forma de olhar uma lista: lista ou quadro, mais o
filtro e a ordem (o texto do endereço). Cada pessoa vê, cria e apaga só as próprias, e só de
listas que ainda consegue abrir; nem um Dono vê as visões dos outros. Até 30 por lista e pessoa.

- O banco guarda só o que um endereço pode conter (`?` seguido de letras, números e `%._~:=&+-`)
  e recusa qualquer outra coisa, então uma visão nunca vira um link para fora nem código.
- Uma visão não guarda dados nem concede acesso: aplicada, só esconde o que a pessoa já vê.
- Quem perde o acesso à lista perde as visões dela junto (ficam fora de alcance, não são
  entregues a ninguém).

**Por quê.** Visões compartilhadas com a equipe são úteis, mas pedem decidir quem pode mudar a
visão dos outros; ficam para depois. _Rever com o mantenedor:_ visões da equipe, definidas por
quem gerencia a lista.

## D39 — Calendário pelo dia local, agenda no celular

**Decisão.** A terceira visão é o calendário (`/listas/:id/calendario`): cada item aparece no dia
de um campo de data da lista (escolhido quando há mais de um). Data e hora caem no dia do fuso de
quem olha; data simples cai no próprio dia, sem conversão. Semanas começam no domingo. No
celular, a grade vira agenda: só os dias com itens, com o nome do dia por extenso. Filtros,
ordem e visões salvas valem aqui também; itens sem data ficam numa lista à parte.

**Por quê.** Converter uma data simples para UTC faria um vencimento "dia 20" aparecer no dia 19
para quem está no Brasil. Arrastar um item para outro dia fica para depois (por enquanto a data
muda no próprio item).

## D40 — Tabela com colunas escolhidas no endereço

**Decisão.** A quarta visão é a tabela (`/listas/:id/tabela`): uma linha por item, o título fixo
à esquerda enquanto o resto rola de lado, e as colunas que cada pessoa escolhe (etapa,
responsáveis, criado, atualizado e qualquer campo). A escolha vai no endereço (`colunas=`) junto
com filtro e ordem, então uma visão salva a guarda. Clicar no nome de uma coluna ordena por ela.
Na própria célula muda só a etapa; o resto se edita no item, que abre numa janela.

**Por quê.** Editar qualquer campo direto na célula pede um editor por tipo de campo dentro da
tabela; o painel do item já faz isso bem e com as mesmas regras. _Rever com o mantenedor:_ editar
na célula os campos mais usados.

## D41 — Ordem à mão no quadro, a mesma para todos

**Decisão.** Cada item guarda uma posição na coluna da sua etapa, a mesma para todos que veem a
coluna. Quem pode editar os itens arrasta um cartão para cima ou para baixo (ou usa "Subir" e
"Descer", que aparecem ao chegar no cartão pelo teclado ou apontar para ele). A tela manda a ordem
inteira da coluna; o banco aplica tudo ou nada, só para itens que a pessoa pode editar.

- Mudar a ordem não é mudar o item: "última mudança" e histórico ficam como estavam.
- Um item que muda de etapa ou de lista sem ser posicionado vai para o fim da nova coluna.
- A ordem à mão vale quando a lista está na "Ordem do quadro" (o padrão); com outra ordem
  escolhida, arrastar dentro da coluna não muda nada.

**Por quê.** Numa equipe pequena, a ordem da coluna é combinada entre todos (o que vem primeiro);
uma ordem por pessoa contradiria o quadro dos colegas. _Rever com o mantenedor:_ funcionário que
vê só os próprios itens reordena só os seus, e a posição deles entre os itens que ele não vê fica
como cair.

## D42 — Busca global pelas mesmas regras de leitura

**Decisão.** A busca no alto da página procura palavras nos títulos e descrições dos itens de
todas as listas que a pessoa abre, sem diferença de maiúsculas e acentos, e mostra até 30
resultados, títulos primeiro. A consulta lê os itens pelas mesmas regras de linha de tudo o mais:
funcionário acha só os próprios itens, lista sensível só entra com código recente, a lixeira fica
de fora. O que é digitado vale literalmente (`%` e `_` não viram curingas).

- Campos personalizados, anexos e segredos não entram na busca.
- Cada resultado abre a lista já filtrada por aquele título.

**Por quê.** Uma busca com caminho de leitura próprio seria o jeito mais fácil de vazar um item
entre funcionários; usando as regras de linha, ela não consegue achar o que a pessoa não veria.

## D43 — Linha do tempo de seis semanas, por dois campos de data

**Decisão.** A quinta visão é a linha do tempo (`/listas/:id/linha-do-tempo`): uma linha por item
e uma barra do campo "começa em" ao "termina em" (escolhidos entre os campos de data da lista;
com um só, cada item marca um dia), na cor da etapa. Mostra seis semanas a partir da segunda-feira
da semana anterior, anda de quatro em quatro semanas e volta para hoje. Os títulos ficam fixos
enquanto os dias rolam de lado, também no celular. Barras cortadas na borda mostram o corte.

**Por quê.** Seis semanas cabem numa tela de computador com dias legíveis e cobrem o planejamento
de um mês com folga. Arrastar a barra para mudar as datas fica para depois (as datas mudam no
item, como no calendário).

## Adiado, com motivo

| Item                                                  | Situação                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Passkeys / WebAuthn                                   | Opcional no plano; entra junto com a interface (precisa do navegador).                                       |
| CAPTCHA após falhas                                   | O bloqueio progressivo por conta e por endereço já existe; o CAPTCHA entra com a interface.                  |
| Restrição de login por país                           | Opcional; depende de base de geolocalização, a decidir na fase de implantação.                               |
| Alertas por e-mail e push                             | Os alertas já existem e são listados para os Donos; o envio entra com notificações (Fase 4).                 |
| Checagem de senha vazada                              | Opcional; a política atual recusa senhas curtas, comuns ou com dados da pessoa.                              |
| Pré-visualização de PDF                               | O leitor de PDF do navegador não roda sob `sandbox`; por ora PDF só baixa (ver `docs/design/anexos.md`).     |
| Campos por espaço ou pasta                            | Ver D23: campos por lista com cópia que preserva a origem cobrem o uso; herança fica para depois.            |
| Nome de etapa de outra lista no "tempo em cada etapa" | Item que passou por outra lista mostra o nome da etapa onde esteve lá. Revisar junto com as visões (Fase 3). |
| Colunas configuráveis na lista                        | Hoje os quatro primeiros campos; a escolha por pessoa entra com as visões salvas (Fase 3).                   |
