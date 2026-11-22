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

## D44 — Edição em massa, com a lixeira em massa tratada como ação crítica

**Decisão.** Na visão de lista, cada item tem uma caixa de seleção; com algo selecionado aparece
uma barra para mover tudo para uma etapa, passar tudo para uma pessoa e mandar tudo para a
lixeira. Cada mudança é tudo ou nada: se um dos itens escolhidos não pode ser mudado por quem pede
(ou saiu da lista), nada muda.

- Mover e passar seguem as regras de um item por vez: mover pede poder editar cada item; passar é
  só de quem distribui trabalho na lista e só para quem pode trabalhar nela.
- Mandar **um** item para a lixeira pela barra é o mesmo que o botão do item. Mandar **vários**
  exige a capacidade "Apagar em massa" e o código do autenticador recente, fica no registro e
  alerta os Donos.
- O banco faz a mesma conta por conta própria (`0026_bulk_trash.sql`): soma os itens mandados para
  a lixeira na mesma requisição, mesmo um comando por vez, e recusa o segundo sem a capacidade e o
  código.

**Limitação conhecida.** A soma é por requisição. Quem tem só "editar" pode mandar itens um a um,
em requisições separadas, como já podia pelo botão do item; isso fica no histórico de cada item,
mas não dispara o alerta. Um alerta por volume em janela de tempo fica para quando as
notificações existirem (Fase 4).

**Por quê.** Apagar muita coisa de uma vez é o estrago mais rápido que uma conta comprometida ou um
engano pode fazer; por isso a barreira está onde o dano é grande e não no uso comum.

## D45 — Prioridade, início e prazo nativos, com datas como dias

**Decisão.** Todo item tem prioridade, data de início e prazo próprios, fora dos campos
personalizados (`0027_priority_dates.sql`).

- **Prioridade de 1 a 4**, 1 a mais urgente (Urgente, Alta, Normal, Baixa), ou nenhuma. São os
  quatro níveis da ferramenta que o Cérebro substitui, então a migração passa direto. _Rever com o
  mantenedor:_ se a escala precisar ser outra (1 a 5, 1 a 10), muda só a regra da coluna e a
  lista de nomes.
- **Início e prazo são dias, não horários.** "Vence dia 20" é dia 20 para todo mundo, em qualquer
  fuso. Hora marcada continua possível com um campo de data e hora. O começo nunca vem depois do
  prazo: a API e o banco recusam.
- **Atrasado** é o item com prazo antes de hoje (no fuso de quem olha) que não está numa etapa de
  "concluído" ou "encerrado".
- Quem edita o item define os três; o histórico do item registra cada mudança, escrito pelo banco.
- Na tela: marcas ao lado do título na lista e no quadro (só as duas prioridades mais altas e o
  que está atrasado ou vence hoje ganham cor); filtro por prioridade e por prazo (atrasados, vencem
  hoje, próximos 7 dias, sem prazo); ordem e agrupamento por prioridade; colunas na tabela.
- O calendário passa a abrir pelo prazo, e a linha do tempo vai do início ao prazo do próprio
  item; os campos de data da lista continuam disponíveis nos dois.

**Cliente, local e marcadores** ficam como campos personalizados (texto, escolha única,
marcadores), que já filtram, ordenam e agrupam. _Rever com o mantenedor_ se algum deles precisar
de regra própria (por exemplo, cliente ligado a outro cadastro).

## D46 — Subtarefas como itens comuns, com a família sempre inteira

**Decisão.** Subtarefa é um item como qualquer outro, com um pai: um item da mesma lista que não é
subtarefa (um nível só) (`0028_subtasks.sql`).

- **Quem vê e edita segue as regras de qualquer item, não as do pai.** Herdar do pai mostraria a
  um funcionário o trabalho de outro, se as duas pessoas trabalham no mesmo item. Uma subtarefa
  criada pela funcionária é dela; uma criada por outra pessoa só aparece para ela se for passada
  para ela.
- Pendurar trabalho num item é mudar esse item: só quem pode editá-lo (API e banco).
- **A família fica inteira:** subtarefa viva fica na lista do pai e com o pai vivo. O banco
  confere no fim de cada transação, por qualquer caminho.
- Mover o pai leva as subtarefas vivas (para a primeira etapa de lá); mover uma subtarefa sozinha
  a solta do pai. Se o pai tem uma subtarefa que quem move não pode mover, nada se move.
- Mandar o pai para a lixeira leva as subtarefas e conta como **vários itens**: pede a capacidade
  "Apagar em massa" e o código, como a lixeira em massa (D44). Restaurar o pai traz as que foram
  com ele; uma subtarefa restaurada sem o pai volta solta. _Rever com o mantenedor:_ hoje um ADM
  sem a capacidade apaga um item com subtarefas mandando as subtarefas primeiro, uma por vez.
- O histórico registra de qual item a subtarefa é, só pelo número: quem lê a subtarefa pode não
  ver o pai, e na tela ele aparece como "outro item".
- Na lista, as subtarefas ficam dobradas debaixo do pai, com "1/2 subtarefas concluídas"; nas
  outras visões aparecem como itens, com "Subtarefa de …".

**Junto:** item na lixeira também não muda de prioridade, datas ou pai direto no banco (a regra
antiga só olhava título, descrição e lista).

## D47 — Checklist dentro do item, com quem marcou escrito pelo banco

**Decisão.** Cada item tem uma checklist: linhas curtas (até 500 caracteres), feitas ou não, até
100 por item (`0029_checklist.sql`). Uma só por item, na ordem em que as linhas foram postas.

- Segue o item: quem vê lê, quem edita põe, marca, renomeia e tira; nada muda com o item na
  lixeira, e as linhas vão junto quando o item sai de vez.
- **Quem marcou e quando são escritos pelo banco.** A aplicação não consegue dizer que outra
  pessoa marcou nem mudar a data; nem o dono do banco tira uma linha de um item e põe em outro.
- Cada mudança entra no histórico do item com o texto da linha como estava.
- Na tela: a marca "Checklist 1/2" ao lado do título (verde quando completa) e a seção no painel;
  o tique aparece na hora e volta atrás só se o servidor recusar.

**Fica para depois:** várias checklists com nome no mesmo item, reordenar linhas e transformar
uma linha em subtarefa. A API já guarda a posição de cada linha.

## D48 — Comentários: escreve quem edita, só o autor muda, apagado some do aplicativo

**Decisão.** Cada item tem comentários, em ordem (`0030_comments.sql`).

- **Lê quem vê o item; escreve quem pode editá-lo.** Quem só vê a lista lê, mas não comenta:
  "ver" continua sendo só ler. _Rever com o mantenedor_ se quem só vê deve poder perguntar.
- **Só o autor muda o que escreveu**, e cada versão anterior fica guardada e legível para quem lê
  o comentário ("editado" e "Ver versões anteriores").
- **Apagar:** o autor, ou quem gerencia a lista (moderação). Apagado, o comentário mostra só quem
  apagou e quando; o texto sai do alcance da aplicação, inclusive as versões anteriores, e fica
  só no banco, para quem cuida do servidor. Um comentário apagado não volta nem muda.
- Autor, horário, edição e quem apagou são escritos pelo banco; as versões não podem ser
  escritas, mudadas nem apagadas, nem pelo dono do banco.
- Nada muda nos comentários de um item na lixeira; eles saem junto quando o item sai de vez.
- Texto puro, com as quebras de linha como foram escritas; até 10 mil caracteres.

As menções com @ entram na próxima fatia, junto do que decide quem pode ser mencionado.

## D49 — Menções só de quem vê o item, e os nomes de cada item

**Decisão.** Um comentário pode mencionar pessoas com @ (`0031_mentions.sql`).

- **Só quem vê o item pode ser mencionado nele.** Uma menção nunca mostra um item a ninguém. Quem
  vê é decidido pelo banco, com as mesmas regras das requisições da pessoa: Dono vê tudo; os demais
  pela concessão mais próxima (lista, depois pasta, depois espaço), todos os itens ou só os que
  criaram ou receberam; conta suspensa não vê nada.
- Só o autor menciona, enquanto o comentário existe e o item não está na lixeira; até 20 por
  comentário. Menção feita não muda nem some (editar só acrescenta), nem pelo dono do banco. Quem
  um comentário apagado mencionava sai do alcance junto com o texto.
- **As pessoas de um item:** quem o vê e quem escreveu, apagou ou foi mencionado nos comentários.
  É o que a tela usa para dar nome a quem comenta; só quem vê o item recebe essa lista. Antes,
  para um funcionário, quem comentava aparecia como "outra pessoa".
- Na tela, "Mencionar alguém" oferece só quem vê o item (e não quem escreve); a menção aparece em
  destaque no texto. O aviso para quem foi mencionado chega com as notificações (próxima fatia).

## D50 — Recorrência ao terminar, feita pelo banco

**Decisão.** Um item pode repetir a cada N dias, semanas, meses ou anos (1 a 99)
(`0032_recurrence.sql`). Quem edita o item define ou tira a regra.

- **O próximo nasce quando o item chega a uma etapa de concluído ou encerrado**, vindo de uma
  etapa aberta, na mesma lista, fora da lixeira. Quem faz é o banco, então vale para qualquer
  caminho: lista, quadro, edição em massa, API.
- O próximo leva título, descrição, prioridade, responsáveis (que ainda podem trabalhar na lista),
  valores de campo (o que não couber mais fica para trás; arquivos não vão, porque os anexos são do
  item anterior) e a checklist desmarcada. Entra na primeira etapa.
- **Datas:** um passo depois do último prazo; terminado atrasado, somam-se passos inteiros até cair
  hoje ou depois; sem prazo, um passo depois de hoje. O início anda junto. "Hoje" é o dia do
  servidor.
- A regra passa para o novo item: terminar o anterior de novo não cria mais nada.
- Subtarefa repete debaixo do mesmo pai quando quem terminou ainda pode editar o pai; senão, sai
  solta.
- O histórico guarda quem mudou a regra e, no novo item, de qual ele veio.

**Fica para depois:** repetir por agenda, sem depender de terminar (o ClickUp oferece as duas);
repetir também as subtarefas de um pai recorrente.

## D51 — Avisos dentro do aplicativo, escritos pelo banco; push com o PWA

**Decisão.** O banco escreve um aviso, por qualquer caminho (`0033_notifications.sql`), quando:

- a pessoa é **mencionada** (no lugar do aviso de comentário, para o mesmo comentário);
- um item é **passado** para ela;
- alguém **comenta** num item dela (com ela), ou num item que ela criou e que não está com ninguém;
- um item dela **vence hoje** ou está **atrasado**, conferido de hora em hora na mesma rotina da
  lixeira, uma vez por prazo e por tipo. "Hoje" é o dia do servidor.

**Nunca para quem causou, nunca para quem não vê o item.** Cada pessoa lê só os próprios avisos, e
só enquanto ainda vê o item; perdeu o acesso, o aviso some da lista e da contagem. Marcar como lido
é a única mudança, com o horário escrito pelo banco.

Na tela, "Avisos" no alto de toda página com a contagem de não lidos (conferida a cada minuto) e
uma página com os avisos em frases; abrir um marca como lido e leva à lista filtrada pelo item.

**Junto (D44):** uma pessoa que manda dez itens ou mais para a lixeira em dez minutos, mesmo um por
vez em requisições separadas, gera o alerta "Muitos itens mandados para a lixeira em pouco tempo"
para os Donos.

**Push no celular fica para a Fase 7**, com o service worker do PWA: precisa de chaves próprias da
instalação, da inscrição de cada aparelho e de envio para fora do servidor. Preferências por pessoa
(o que avisar) entram junto.

## D52 — Tempo real que só diz "isto mudou", nunca o quê

**Decisão.** A página aberta recebe por um fluxo de eventos (`GET /api/events`) apenas qual lista e
qual item mudaram, se os avisos da pessoa mudaram ou se o acesso dela mudou, e então pergunta de
novo pelas rotas de sempre, com as regras de sempre (`0034_live.sql`).

- **O banco anuncia só ids:** a lista, o item, e de quem o item é (quem criou e com quem está).
  Nunca título, valor, texto de comentário ou nome. Anúncios iguais na mesma transação saem uma
  vez.
- **O servidor escuta uma vez e repassa por pessoa:** só para quem abre a lista; numa lista em que
  a pessoa vê só os próprios itens, só quando o item é dela (senão saberia que o item de um colega
  mudou); lista sensível só com o código recente.
- A sessão é conferida de novo a cada batida (25 s) e quando o acesso da pessoa muda; deixou de
  valer, o fluxo termina. Até 5 fluxos por pessoa.
- Na página, mudanças que chegam juntas são lidas uma vez (300 ms). A contagem de avisos continua
  conferida a cada minuto, caso o fluxo caia.
- Sem dependência nova: Server-Sent Events do próprio navegador e `LISTEN/NOTIFY` do PostgreSQL. O
  proxy reverso precisa repassar o fluxo sem guardar (ver `infra/README.md`).

## D53 — Automações: regras por lista que agem com o acesso de quem as salvou

**Decisão.** Cada lista tem regras "quando, se, então" (`0035_automations.sql`). Quando: um item é
criado, ou entra numa etapa (de uma etapa, para uma etapa, ou qualquer mudança). Se (todas valem,
até 10): etapa, prioridade, responsável (ou ninguém), campo de escolha ou caixa de marcar. Então
(até 5, em ordem): mover de etapa, mudar a prioridade, passar para alguém, avisar pessoas (até 10),
comentar. Até 50 regras por lista.

- **A regra age com o acesso de quem a salvou por último, nunca com mais.** Durante a regra, e só
  durante ela, o banco troca quem está agindo para o autor, sem código recente do autenticador, numa
  linha que o aplicativo não consegue escrever (`authz.request_ctx`). Todas as travas, carimbos e o
  histórico veem o autor, e o que ele não pode, a regra não pode: item que ele não edita fica de
  fora, lista sensível também (por isso listas sensíveis não aceitam regras). Ao terminar, a pessoa
  volta a ser ela mesma. **Ligar, pausar ou mudar uma regra faz ela agir com o acesso de quem
  salvou** — a tela diz isso antes de salvar.
- **Quem vê e quem escreve:** quem gerencia a lista vê as regras e o registro; só quem também tem a
  permissão "automações" (`automations.manage`, já existente) cria, muda ou apaga. As duas coisas são
  conferidas pela API e pelo banco.
- **Marcada como da regra:** o que a regra faz fica no histórico, nos comentários e nos avisos com o
  nome dela ("A automação “X” mudou a prioridade"), e o autor continua registrado. Comentário de
  regra não é reescrito por ninguém, só apagado como qualquer outro.
- **Nunca impede a pessoa:** a regra que não consegue agir é desfeita por inteiro (nenhuma ação pela
  metade) e anotada no registro como "Falhou", com o motivo; a ação da pessoa fica. Quem salvou sem
  poder mais editar o item gera "Não agiu". Item que não cumpre as condições não é anotado.
- **Regras que disparam regras param no terceiro nível**, contados no mesmo lugar protegido.
- **Item criado é olhado no fim da requisição**, já com responsáveis, campos e checklist; mudança de
  etapa é tratada na hora, depois do histórico e da recorrência. Item movido para outra lista não
  dispara regras de etapa. Importação e manutenção (sem pessoa conectada) não disparam regras.
- **Avisos:** só para quem vê o item, e nunca para quem causou a mudança.
- **Registro:** 90 dias, imutável; apagado junto com a regra. A limpeza roda com a da lixeira.
- **Fica para os próximos passos da Fase 5:** gatilhos por campo, responsável e prazo (vencendo ou
  atrasado), ações de definir campo, prazo relativo, mover de lista e criar item ou subtarefa, e as
  regras de quem pode mover para cada etapa.

## D54 — Limite de requisições por sessão, em toda rota

**Decisão.** Toda rota da API passa por um limite de requisições por minuto
(`@fastify/rate-limit`): 1 200 por padrão (20 por segundo, sustentados por um minuto), ajustável por `CEREBRO_REQUESTS_PER_MINUTE` (60 a
100 000). Acima disso, a API responde 429 `too_many_requests` com quanto esperar, e a página diz
"Muitas ações em pouco tempo. Espere … e tente de novo."

- **Contado por sessão**, por um resumo do token (nunca o token), e por endereço antes de entrar:
  um escritório inteiro atrás de um mesmo endereço não divide uma cota só. As tentativas de
  entrada continuam com o bloqueio progressivo próprio (por conta e por endereço).
- **O fluxo de tempo real abre no máximo 20 vezes por minuto** por sessão, além do limite de 5
  abertos ao mesmo tempo. Recusado, a página tenta de novo em 15 s, dobrando até 5 min, e lê tudo
  de novo quando volta.
- **Por que 1 200:** cada ação na página pede de novo o que mudou, e o tempo real faz o mesmo a cada
  mudança de um colega; o percurso em navegador, mais rápido do que qualquer pessoa, passou de 600
  num minuto. Um script sem freio passa longe de 1 200.
- **Por quê agora:** o CodeQL apontou a rota do tempo real como sem limite (alerta alto, CWE-770).
  Valia para todas: um script com uma sessão válida conseguia fazer requisições sem parar. O
  limite fica na memória do processo, o que basta para uma instância só (Fase 12).
- **Dependência nova:** `@fastify/rate-limit` 11.2.2 (equipe do Fastify, publicada há mais de 3
  dias), com `toad-cache`, `ip-address`, `@lukeed/ms` e `fastify-plugin` (já usado). Nenhum script
  de instalação.

## D55 — Mais gatilhos e ações das automações

**Decisão.** Além de D53 (`0036_automation_triggers.sql`):

- **Quando um campo muda**, para qualquer valor ou, em campo de escolha e caixa de marcar, para um
  valor ("passa a ser Alfa", "é desmarcado"; desmarcar e limpar contam igual). O mesmo valor de
  novo não é mudança.
- **Quando alguém recebe um item**, qualquer pessoa ou uma pessoa. Tirar alguém não dispara.
- **Preencher ou limpar um campo**, conferido pelo banco contra o tipo do campo ao salvar e de
  novo ao agir (opção arquivada depois faz a regra falhar inteira e ficar anotada). Campo secreto
  e de arquivos ficam de fora: segredo só é escrito por quem o digitou, e arquivo vem dos anexos do
  próprio item.
- **Prazo daqui a N dias** (0 a 365) ou sem prazo. Se o item começa depois do novo prazo, a regra
  falha inteira.
- **Criar uma subtarefa**, pela pessoa que salvou a regra; nunca debaixo de uma subtarefa.
- **O que é feito enquanto o item é criado faz parte da criação:** campos preenchidos e
  responsáveis postos na mesma requisição disparam as regras de "item criado", não estas.
- Ficam para o próximo passo: prazo chegando ou vencido e regras agendadas (precisam agir sem uma
  pessoa conectada) e mover de lista.

## D56 — Etapas que só recebem itens de um papel para cima

**Decisão.** Cada etapa pode dizer quem põe itens nela: quem edita o item (padrão), gestores ou
acima, ADMs ou acima, ou só Donos (`0037_stage_entry.sql`). Quem gerencia a lista escolhe, em
"Editar etapas".

- **Conferido pelo banco em todo caminho:** mover o item (lista, quadro, tabela, em massa), criar
  já na etapa, mover para outra lista escolhendo a etapa, e regra agindo com o acesso do autor.
  Recusado, a API responde 403 `stage_restricted` e o item fica onde estava.
- **Tirar um item da etapa não é restrito**, e **cair na primeira etapa sozinho não é escolher**:
  item criado sem etapa, item que se repete e item levado para outra lista sem escolher a etapa
  vão para a primeira etapa mesmo que ela seja restrita.
- A página não oferece a etapa a quem não pode (a opção aparece desabilitada); o banco decide.
- Manutenção pelo dono do banco (importação) não é uma pessoa movendo itens.
- **Rever com o mantenedor:** restringir também quem tira itens de uma etapa (ex.: só gestor
  reabre o que está em "Feito").

## D57 — Regras que esperam o prazo, rodadas sem ninguém conectado

**Decisão.** Uma regra pode agir quando o prazo de um item chega: de 1 a 30 dias antes, no dia ou
de 1 a 30 dias depois (`0038_automation_due.sql`). Vale para itens não concluídos e fora da
lixeira, uma vez por regra, item e prazo (prazo novo é ocasião nova). A rotina de hora em hora,
a mesma da lixeira e dos lembretes, roda essas regras.

- **Sem ninguém conectado, a identidade continua só no banco:** para cada regra, e só enquanto
  ela age, a função da rotina põe o autor como quem age, sem código recente e sem sessão; quando a
  função termina, ninguém fica agindo. A função se recusa a rodar dentro da requisição de uma
  pessoa, então nunca serve para pegar a identidade de outro.
- Todo o resto de D53 vale: acesso do autor e nunca mais, regra desfeita inteira quando falha,
  registro, marcada como da regra, e as regras que ela dispara param no terceiro nível.
- **Avisos:** ninguém causou a mudança, então todos os que a regra avisa e que veem o item recebem,
  inclusive o autor.
- **Ficam para depois:** regras agendadas sem item (ex.: "toda segunda, crie a tarefa X", que a
  recorrência já cobre em parte) e mover de lista por regra (precisa repetir no banco as regras
  de mudança de lista da API: subtarefas, responsáveis e campos).

## D58 — Painel da lista contado como a pessoa

**Decisão.** Cada lista ganha a aba **Painel** (`/listas/:id/painel`): total de itens, em aberto,
concluídos, atrasados e que vencem hoje; quantos por etapa (com quanto tempo, em média, os itens
ficam em cada uma, sobre as passagens que terminaram nos últimos 90 dias); com quem; e por campo
de escolha (ex.: fornecedor). A participação de cada etapa no total responde "quanto está
bloqueado".

- **Contado como a pessoa:** a API soma com as regras de linha de quem pergunta, então quem vê só
  os próprios itens lê os números dos próprios itens (a tela avisa). Lista sensível pede o código.
- **Nomes:** nomes de pessoas não são legíveis em geral; uma função do banco
  (`0039_list_summary.sql`) devolve só os nomes de quem está nos itens que a pessoa vê naquela
  lista.
- **Desenho:** números sempre escritos; as barras, de uma cor só (validada para o fundo escuro),
  só ajudam a comparar. Cada bloco é uma tabela, lida por leitores de tela.
- A tela inicial (D59) e o relatório semanal (D60) completam a Fase 6.

## D59 — Tela inicial de cada pessoa

**Decisão.** Uma seção nova, **Início** (`/inicio`), primeira do menu, mostra o que cada pessoa
precisa ao entrar: os itens abertos com ela (atrasados, vencem hoje, próximos 7 dias, mais adiante
ou sem prazo), quantos avisos esperam leitura e os painéis das listas que ela fixa, na ordem que
ela escolhe.

- **Lido como a pessoa:** os itens vêm das regras de linha de sempre (só os dela, fora da lixeira,
  em etapas que não são de concluído ou encerrado), até 200, pelo prazo. Lista sensível pede o
  código antes de mostrar os números do painel.
- **Painéis fixados:** guardados no servidor (`0040_home.sql`), até 12 por pessoa, então a ordem
  vale em qualquer aparelho. Cada um só lê, fixa e tira os próprios; só fixa lista que abre; lista
  apagada ou perdida sai sozinha (a tabela segue a lista, e a leitura passa pelas regras de linha
  da lista).
- **No painel fixado:** os totais e a contagem por etapa; "com quem" e os campos ficam no painel
  completo da lista, a um clique.
- **Endereço `/`:** continua sendo Espaços, para não quebrar links já guardados. Abrir o
  aplicativo direto em Início é uma escolha simples a confirmar com o mantenedor.

## D60 — Relatório semanal

**Decisão.** Toda segunda-feira, a rotina de hora em hora escreve o relatório da semana que
terminou (segunda a domingo, no calendário da instalação): por lista, quantos itens entraram,
quantos foram concluídos na semana (e continuam concluídos), quantos estão em aberto e quantos
estão atrasados; e, por pessoa, concluídos, em aberto e atrasados dos itens com ela. A tela
**Relatórios** mostra a semana escolhida e quanto cada número mudou em relação à anterior.

- **Quem lê:** os Donos, e quem recebe deles a permissão nova **Ver relatórios**
  (`reports.view`). Mesmo com ela, cada um lê só as listas em que vê todos os itens; lista
  sensível só depois do código (a página oferece confirmar). Nomes de pessoas vêm de uma função do
  banco que só nomeia quem está nas linhas que a pessoa pode ler.
- **Quem escreve:** só a rotina (`0041_weekly_report.sql`). A função se recusa a rodar dentro de
  uma requisição; a aplicação não insere, muda nem apaga relatório. Uma semana já escrita não é
  reescrita. Guarda-se um ano.
- **Contagem:** feita no momento em que o relatório é escrito, na primeira hora da segunda-feira.
  Se o servidor estiver parado nessa hora, o relatório sai quando ele voltar, com os números
  daquele momento. Item na lixeira não conta.
- **E-mail:** fica para quando o mantenedor decidir o servidor de e-mail. Rever com o mantenedor.

## D61 — Instalável, abre sem conexão, e o service worker nunca guarda dados

**Decisão.** O aplicativo pode ser instalado (manifesto com o nome da instalação, ícones) e abre
sem conexão. O service worker guarda só a página e os arquivos com impressão digital; nunca toca
em `/api/`. Abrir uma tela pede primeiro à rede, para uma correção de segurança chegar no próximo
acesso. Desenho completo da Fase 7 em [`docs/design/pwa.md`](design/pwa.md).

- **Sem dependência nova:** o service worker é construído pelo próprio Vite, depois da página,
  com a lista de arquivos escrita dentro.
- **Manifesto pela API:** leva o nome da instalação, que a tela de entrada já mostra; nada mais.
- **Sem conexão:** a página diz isso e tenta de novo sozinha; com o aplicativo aberto, uma faixa
  avisa que nada é salvo até a conexão voltar.
- Os dados offline (cifrados, com expiração e apagamento remoto) são a próxima parte, como no
  desenho.

## D62 — Leitura offline, cifrada, do que a pessoa já abriu

**Decisão.** O aparelho guarda, cifrado, o que o servidor acabou de responder:

- a conta da pessoa, a estrutura que ela vê e o Início sem nada de lista sensível;
- os itens, as etapas e os campos das listas não sensíveis que ela abriu.

Sem conexão, a página mostra o que foi guardado e diz de quando é. Nada de lista sensível, valor
secreto, anexo, auditoria ou pessoas vai para o aparelho. Desenho em
[`docs/design/pwa.md`](design/pwa.md), seção 3.

- **Cifragem:** cada registro vai cifrado com AES-GCM de 256 bits. O vetor é novo a cada gravação
  e o registro fica preso ao seu endereço. A chave é gerada no aparelho, não exportável, como pede
  o roteiro. O limite está escrito no desenho: a chave fica no perfil do navegador.
- **Expira** depois de 7 dias sem falar com o servidor.
- **Apagado** em quatro casos: ao sair (antes de avisar o servidor), quando a sessão acaba, ao
  entrar e por ordem remota (próxima parte). Resposta pedida antes de apagar e que chega depois
  é descartada.
- **Só leitura:** mudar algo sem conexão continua recusado, com aviso. A fila de mudanças é a
  parte 4 da Fase 7.
- Rever com o mantenedor: os 7 dias.

## D63 — Apagar à distância é revogar o aparelho

**Decisão.** Toda resposta "sem sessão" do servidor apaga o que o aparelho guardou para ler sem
conexão, a chave junto, antes de qualquer outra coisa. Isso acontece quando a sessão vence, o
aparelho é revogado, a sessão é encerrada em "Minha conta", a senha é trocada ou a conta é
suspensa. Por isso revogar um aparelho (tela "Aparelhos") é a ordem de apagar, e a tela diz
isso. Não há um botão separado de "apagar sem revogar": um aparelho que precisa ser limpo não
deve continuar entrando.

- O servidor não recebe confirmação do apagamento, porque o aparelho já não tem sessão para
  mandá-la. A ordem fica na auditoria (`device.revoked`).
- Aparelho que nunca mais se conecta não recebe a ordem. Para esse caso valem a expiração de 7
  dias (D62) e a criptografia de disco do sistema.

## D64 — Mudanças offline conferidas pelo servidor, com conflito por campo

**Decisão.** Sem conexão, a pessoa pode mudar a etapa, o título, o prazo e a prioridade de um item
que o aparelho guardou. A mudança espera numa fila no aparelho, cifrada e apagada junto com o
resto, e leva o que a pessoa via antes de fazê-la (`expected` na mudança do item). Quando a
conexão volta, a fila é enviada em ordem. Se outra pessoa mudou o mesmo campo nesse meio-tempo, o
servidor não escreve nada e responde `409 changed_meanwhile` com o valor de agora. A pessoa
escolhe entre manter a sua versão ou ficar com a de lá. Desenho em
[`docs/design/pwa.md`](design/pwa.md), seção 5.

- **Conferência:** o servidor trava a linha antes de comparar, então duas mudanças ao mesmo tempo
  não passam pela conferência juntas. O conflito só informa os campos que a própria pessoa mandou
  e que ela já podia ver.
- **Regras de sempre:** acesso, etapas restritas e lixeira. O que for recusado aparece com o
  motivo até a pessoa dar ciência; nada some em silêncio.
- **Exceção:** sair ou ter a sessão encerrada apaga também o que não foi enviado.
- **Ficam para depois:** checklist, comentário e campos personalizados offline. Rever com o
  mantenedor se fazem falta.

## D65 — Atualizações pela página, só para Donos, por um serviço separado

**Decisão.** A seção **Atualizações** (só Donos) mostra:

- a versão em uso;
- o botão "Procurar atualização";
- a versão nova encontrada, com as notas em texto puro;
- o botão "Atualizar agora", que pede o código do autenticador de novo;
- o andamento, etapa por etapa.

Quem faz o trabalho é o atualizador, um serviço à parte. Ele é o único com acesso ao Docker e
fica do outro lado de uma rede interna. Desenho em [`docs/design/atualizador.md`](design/atualizador.md).

- **Conversa assinada:** cada requisição da API ao atualizador leva HMAC-SHA256 sobre método,
  caminho, hora, número único e o resumo do corpo, com uma chave que só os dois têm
  (`updater-key`). Fora de 60 segundos não vale.
- **API sem Docker e sem internet para isso:** a API só pergunta e repassa. Procurar, conferir a
  assinatura e instalar são do atualizador (próximas partes).
- **Registro:** fica na auditoria cada procura, cada pedido (com de qual versão para qual), cada
  recusa (com o motivo) e cada resultado, uma vez só.
- **Sem atualizador**, a página diz isso e mostra a versão em uso (`CEREBRO_VERSION`, escrita na
  imagem quando ela é construída).
- Nunca atualiza sozinho.

## D66 — O atualizador: um programa pequeno, sem dependências, que não confia em nada sem assinatura

**Decisão.** O atualizador (`apps/updater`) é um programa Node sem dependências além do pacote
compartilhado. Ele só responde a requisições assinadas pela API, dentro de um minuto e nunca
repetidas. Responde em três endereços: situação, procurar e aplicar.

- **Procurar:** pega a maior release publicada e estável acima da versão em uso. Rascunhos,
  pré-releases e nomes que não sejam versão ficam de fora. A release só vale se trouxer o
  manifesto e a assinatura dele, e o manifesto:
  - tem de ser assinado pelo fluxo `release.yml` deste repositório (`cosign verify-blob`);
  - tem de dizer a mesma versão;
  - tem de apontar para uma imagem `ghcr.io/<este repositório>/api` por digest;
  - tem de aceitar a versão em uso como ponto de partida.
    Os arquivos são baixados só do GitHub, pequenos, com redirecionamentos só dentro do GitHub.
- **Aplicar:** só a versão que acabou de passar na procura, uma de cada vez.
  1. Confere de novo a assinatura do manifesto e a da imagem pelo digest (`cosign verify`).
  2. Copia o banco (`pg_dump`). Se isso falhar, nada é trocado.
  3. Baixa a imagem pelo digest.
  4. Troca o digest em `release.env`.
  5. Roda `migrate`.
  6. Sobe a `api`.
  7. Espera a saúde por até 3 minutos.

  Se algo falhar depois da cópia, ele para a versão nova, restaura o banco (`pg_restore` numa
  transação só), volta o digest anterior e sobe a versão anterior. Se nem isso der certo, diz
  onde está a cópia.

- **Sem shell:** todo comando é uma lista fixa de argumentos.
- **Testes:** Docker, GitHub, cosign e disco são trocados por versões de mentira, para provar a
  ordem dos passos, as recusas e a volta atrás.
- O protocolo assinado foi para o pacote compartilhado (`@cerebro/shared/protocol`), usado pelos
  dois lados.
- **Fica para a próxima parte:** o andamento vive na memória do atualizador. Se ele for
  reiniciado no meio de uma atualização, a página volta a mostrar só a versão em uso.

## D67 — Release assinada pelo próprio fluxo, e o atualizador como perfil do compose

**Decisão.** Publicar uma release (tag `v1.2.3`) dispara o `release.yml`. O fluxo espera a
aprovação no ambiente `release` e então:

- constrói as imagens da API e do atualizador;
- publica as duas no GHCR e assina cada uma pelo digest, com cosign sem chave guardada (a
  identidade é a do próprio fluxo, via OIDC);
- atesta o SBOM (SPDX) na imagem da API;
- anexa à release o manifesto `cerebro-release.json`, assinado com `cosign sign-blob`, e o SBOM.

As ações de terceiros ficam fixadas por SHA, em versões publicadas há mais de 3 dias. O
atualizador só aceita o que tiver exatamente a identidade desse fluxo.

- **No servidor:** o atualizador é o perfil `updater` do `compose.yaml`. Ele é o único com o
  socket do Docker e roda só com o que precisa: sistema de arquivos somente leitura, sem
  capacidades, sem porta publicada, só nas redes `updates` (interna, com a API) e `edge`
  (GitHub e GHCR).
- **A chave:** o `init` gera a `updater-key` também em instalações antigas, sem sobrescrever.
- **Imagem e versão em uso:** ficam no `.env` ao lado do `compose.yaml`, que o compose lê
  sozinho. O atualizador troca só essas duas linhas.
- **Imagem do atualizador:** cliente oficial do Docker com o compose, Node e cosign 3.1.4 com o
  resumo conferido. O CI passa a construí-la e confere que o cosign e o compose estão lá e que
  ela não sobe sem saber qual repositório seguir.
- **Ainda manual:** o próprio atualizador se troca à mão, pelo digest publicado na release.
  Rever com o mantenedor.

## D68 — Cópias com restic, cifradas antes de sair, e restauração provada todo mês

**Decisão.** O serviço `apps/backup` faz uma cópia por dia, às 03h no fuso do contêiner
(`CEREBRO_BACKUP_HOUR` muda a hora). Em cada cópia:

1. `pg_dump` do banco;
2. `restic backup` do banco, dos anexos e da configuração, marcado com a instalação;
3. retenção de um ano (30 diárias, 26 semanais e 12 mensais) com `restic forget --prune`.

O restic cifra tudo no servidor antes de enviar. O destino é qualquer repositório do restic: um
volume local por padrão, ou o Google Drive pelo rclone (`rclone:<remoto>:<pasta>`), configurado
pelo mantenedor no servidor.

- **Teste mensal**, no dia 1, depois da cópia:
  - confere o repositório (`restic check`);
  - restaura o banco da cópia mais recente num PostgreSQL descartável dentro do próprio contêiner,
    sem rede, só por socket local;
  - confere que há pessoas e que a trilha de auditoria está íntegra;
  - apaga tudo.
- **Situação:** fica gravada num arquivo que a API vai ler, com a última cópia, a última boa, o
  último teste e a próxima.
- **Falhas:** cada falha diz em palavras qual passo deu errado. A cópia anterior continua lá. O
  arquivo do banco sem cifra nunca fica fora do repositório.
- **Senhas:** a do banco vai só para o `pg_dump`; a chave das cópias vai só para o restic, por
  arquivo.
- Sem o socket do Docker; anexos e configuração montados somente para leitura (próxima parte).

## D69 — Backup na instalação: perfil próprio, chave no servidor, situação na página e alertas

**Decisão.** O backup é o perfil `backup` do `compose.yaml`. A imagem parte do PostgreSQL 16
oficial: o `pg_dump` tem a mesma versão do banco, e o servidor fica só para o teste de
restauração. Ela traz `restic` e `rclone` dos pacotes assinados do Alpine.

- **Contêiner:** roda como o usuário 1000 (o mesmo da API, para ler os segredos 0600 que ela
  gerou), sem capacidades e com o sistema somente leitura. Anexos e configuração entram somente
  leitura. Não tem o socket do Docker.
- **Destino:** `CEREBRO_BACKUP_REPOSITORY`. Um volume local por padrão, que não protege contra a
  perda do servidor. O Google Drive vai pelo rclone, com o `rclone.conf` posto pelo mantenedor na
  configuração.
- **A chave das cópias (`backup-password`):** o `init` gera, também em instalações antigas, sem
  sobrescrever. Ela não aparece no aplicativo. O `docs/RESTORE.md` diz como copiá-la uma vez,
  para o cofre e para o papel, e como restaurar do zero.
- **Na página Segurança**, para quem vê a auditoria: última cópia, última boa, próxima e último
  teste de restauração. A API só lê o arquivo de situação do serviço (`CEREBRO_BACKUP_STATUS`).
- **Alertas:** a rotina de hora em hora levanta, uma vez por dia por tipo, cópia que falhou, mais
  de 26 horas sem cópia boa ou teste de restauração que falhou. Só a rotina pode levantar esses
  alertas, e só desses tipos (`0042_backup_alerts.sql`).
- **CI:** o CI constrói a imagem e faz uma cópia de verdade numa instalação recém-criada
  (`CEREBRO_BACKUP_NOW=backup+test`). Confere a cópia gravada e o teste de restauração, que
  restaura e consulta o banco descartável.

## D70 — Marca da instalação: pública, mudada só com permissão e código, logo redesenhado pelo navegador

**Decisão.** Nome, cor e logo são da instalação e aparecem para qualquer pessoa: na tela de entrada,
no título da aba, no ícone e no manifesto. Por isso `/api/brand`, `/brand.css` e `/brand/*.png`
respondem sem sessão, e a página Marca avisa que nada ali pode ser segredo.

- **Quem muda:** quem tem "Configurar o sistema" (`system.config`; o Dono sempre tem), com o código
  confirmado há pouco. O banco também exige isso, por RLS em `instance_settings` e em
  `brand_images`. O serviço de entrada só lê.
- **Cor:** `#rrggbb`, conferido no banco. Precisa de contraste de pelo menos 4,5:1 com a superfície
  mais clara do fundo, porque também pinta texto. Uma cor escura demais é recusada já na tela, com
  o contraste que deu. O texto sobre a cor é a mesma cor escurecida, que sempre passa.
- **Como a cor chega à página:** por uma folha `/brand.css` com duas propriedades, gerada a partir do
  valor conferido. Nada de estilo inline, então a política de conteúdo não muda, e não há piscada
  da cor de fábrica ao abrir.
- **Logo:**
  - SVG nunca entra. O arquivo escolhido não sai do aparelho: o navegador o desenha em três PNG
    (192, 512 e 512 "maskable", com o logo dentro da área que o celular nunca corta).
  - A API confere cada PNG por inteiro, sem biblioteca nova, e guarda uma versão reconstruída só
    com cabeçalho, transparência e pixels. Metadados e textos ficam de fora.
  - Os três tamanhos existem juntos ou nenhum (gatilho no fim da transação).
  - Os ícones saem como `image/png`, com `nosniff` e `default-src 'none'; sandbox`.
  - Na trilha de auditoria fica o resumo SHA-256 de cada tamanho, nunca a imagem.
- **Primeira abertura:** a instalação ganhou um quarto passo, "Deixe com a cara da empresa", que
  dá para pular ("Ficar com a marca de fábrica"). Depois, a página Marca.
- **Sem conexão:** o service worker guarda a folha de cor e os ícones num cache próprio (são
  públicos) e os usa quando a rede falha. Com rede, busca sempre primeiro.

**Por quê.** A empresa reconhece o próprio sistema, e o repositório continua sem a marca de
ninguém. Redesenhar o logo no navegador e reconstruir o PNG no servidor fecha as portas comuns de
um upload de imagem: script em SVG, arquivo que é outra coisa por dentro, bomba de compressão e
metadados com dados pessoais.

## D71 — Formulários públicos: endereço e processo próprios, papel do banco que só envia

**Decisão.** Cada lista pode ter até 20 formulários, cada um com até 20 perguntas. Quem
responde não tem conta. A resposta vira um item da lista.

- **Quem faz:** quem gerencia a lista, com o código confirmado de novo (RLS). Os Donos recebem um
  alerta quando outra pessoa abre, muda ou remove um formulário: é uma porta nova para a lista.
- **Com que acesso envia:** o de quem salvou o formulário por último, nunca mais. O item nasce
  como dessa pessoa, marcado como do formulário no item e no histórico ("O formulário “X” criou
  o item"). As automações da lista rodam como em qualquer item novo. Se o autor perde o acesso
  ou é suspenso, o formulário fecha na hora.
- **O que pergunta:** o título do item (com a pergunta que o autor escolher), um texto livre
  opcional e campos da lista de tipos que um estranho pode preencher: texto, texto longo,
  número, dinheiro, data, escolha única, caixa de marcar, link, e-mail e telefone. Pessoas,
  arquivos, campos secretos, marcadores, avaliação e data com hora ficam de fora. Opções
  arquivadas não aparecem.
- **Onde chega:** na primeira etapa ou na etapa escolhida, se quem salva puder pôr itens nela.
- **Serviço próprio** (`cli forms`, perfil `forms`), num endereço próprio que nunca é o do
  aplicativo:
  - monta só a pasta `forms` da configuração;
  - conecta como `cerebro_forms`, que não lê tabela nenhuma e só executa
    `app.form_view`, `app.form_submit` e `app.forms_brand`;
  - responde só sob o próprio nome de host;
  - páginas sem script, com todo texto escapado e política de conteúdo `default-src 'none'`;
  - aceita só post de formulário comum da própria origem (por isso `Referrer-Policy:
same-origin`: com `no-referrer`, o navegador manda `Origin: null` no próprio envio).
- **Contra abuso:**
  - carimbo assinado (HMAC) com a hora em que a página foi entregue: menos de 3 segundos ou mais
    de 6 horas não passa;
  - campo isca escondido: quem o preenche recebe "obrigado" e nada é guardado;
  - 10 envios por endereço a cada 10 minutos;
  - no banco, no máximo 500 respostas por dia por formulário, qualquer que seja a origem;
  - nada sobre quem enviou é guardado (nem endereço IP).
- **Conferido duas vezes:** cada resposta é lida campo a campo no serviço (com as mesmas regras de
  valor do aplicativo, em `packages/shared`) e de novo no banco.

**Por quê.** Quem preenche é de fora; o pior caso é o serviço dos formulários ser tomado. Mesmo
assim, quem o tomasse só conseguiria mandar respostas, no limite do dia, como o autor de um
formulário aberto: não leria nada, não teria sessão nem chave da instância.

**Rever com o mantenedor.** CAPTCHA continua adiado (o carimbo e a isca seguram o grosso dos
robôs). Anexos em formulário esperam a decisão do antivírus (D33).

## D72 — Revisão independente: o banco segura sozinho o que antes dependia de cada serviço

**Contexto.** Três revisores que não escreveram o código leram o banco, a API com os serviços, e a
página com a instalação, procurando o que alguém de dentro (com acesso maior) ou de fora conseguiria
forçar. Nada crítico ou alto. O que foi corrigido está aqui; o que ainda está em correção fica fora
do repositório público até sair.

**Decisão.** Cada limite passa a valer no ponto que nenhum serviço contorna, mesmo que um deles seja
levado a mandar qualquer comando ao banco.

- **Conceder não amplia o próprio acesso** (0045): quem concede um espaço ou uma pasta precisa ter,
  em cada regra própria abaixo, pelo menos o nível e o alcance que entrega.
- **Entrada e limites:**
  - e-mail inexistente bloqueia igual a um real (chave por HMAC do e-mail), então errar a senha não
    revela quem tem conta;
  - só o número configurado de proxies vale no `X-Forwarded-For` (`CEREBRO_TRUST_PROXY`, "true" vale
    1), e IPv6 conta por /64;
  - além do limite por sessão, um teto por endereço: cookie inventado não abre balde novo;
  - a conferência de origem dos GET julga pela rota alcançada, não pela URL crua.
- **Rotinas só fora de uma requisição** (0046): verificação de anexos, faxinas e lembretes
  recusam quem chama com identidade. O corpo de cada uma fica sob outro nome, sem permissão para
  ninguém.
- **O serviço de entrada confere senhas e códigos; o banco segura a porta depois disso:**
  - aparelho só entra ou volta como "aguardando" (salvo o do primeiro Dono, durante a instalação);
    aprovar é sempre de uma pessoa, pelo aplicativo;
  - sessão só abre por `auth.open_session`, num aparelho aprovado da mesma pessoa, ativa, e só para
    quem mostra o segredo desse aparelho (o banco guarda só o resumo). Ninguém abre sessão num
    aparelho que ninguém aprovou;
  - depois de aberta, a sessão só muda para terminar (de vez) ou para marcar o código confirmado
    agora. Validade, dono, aparelho e token não mudam;
  - convite é feito pelo aplicativo; o serviço de entrada só o usa, uma vez. Conta só fica ativa
    pelo próprio convite, usado no mesmo passo.
- **Contas na requisição, não em variável de sessão:** o total de itens mandados à lixeira numa
  requisição fica em `authz.request_ctx`, que nenhum serviço escreve. A regra que passa para o
  próximo item da recorrência é reconhecida por acontecer dentro de outro gatilho
  (`pg_trigger_depth()`), o que nenhum serviço finge.
- **Regras de pessoas sob todos os serviços:** etapa restrita, quem pode receber item, campo de
  pessoas e subtarefa valiam só na conexão do aplicativo. Agora valem para os três serviços e para
  quem age como pessoa (`authz.enforced()`); só a manutenção feita pelo dono do banco passa sem.
  Assim, as regras que um formulário dispara obedecem ao autor delas, e um formulário cujo autor
  não pode mais pôr itens na etapa escolhida fecha.
- **Lista:** baixar a proteção de uma lista sensível ou mudá-la de lugar é só do Dono, com código
  confirmado há pouco, e entra na auditoria (como arquivar e proteger).
- **Notificação** só aparece, mesmo lida direto na tabela, enquanto a pessoa ainda vê o item.
- **Auditoria:** do aplicativo, só entradas da lista conhecida, com quem fez, sobre os alvos
  conhecidos e com no máximo 8 KB de detalhes; do serviço de entrada, só as entradas de entrada.
- **Ao mesmo tempo:** duas instalações simultâneas, ou dois Donos rebaixando um ao outro, fazem
  fila na linha de configurações; o segundo conta de novo e é recusado.

**Por quê.** O pior caso que cabe imaginar é um serviço ser tomado. Com isso, quem tomasse o
serviço de entrada ainda precisaria que alguém com autoridade aprovasse o aparelho dele; quem
tomasse o aplicativo continuaria preso às permissões da pessoa da requisição; e quem tomasse os
formulários só mandaria respostas, como antes.

**O que sobra, por escrito.** O banco não confere o código do autenticador. Um serviço de entrada
tomado, nas mãos de quem já tem conta e aparelho aprovado, poderia marcar o código como confirmado
sem digitá-lo. O banco não amarra isso à sessão de quem tomou o serviço: com o token de outra
sessão viva (um cookie roubado), ela também seria marcada. (Corrigido o texto na D84.)

## D73 — Cada serviço monta só a sua pasta da configuração; o atualizador sai por uma rede só dele

**Decisão.** O volume `config` passa a ter uma pasta por serviço, e cada serviço monta só o que
usa (volume com `subpath`, Docker 26 ou mais novo, o que os formulários já exigiam):

| Pasta      | O que tem                                                     | Quem monta                       |
| ---------- | ------------------------------------------------------------- | -------------------------------- |
| `api/`     | chave da instância, senhas da API e da entrada, token inicial | API; migrações (só leitura)      |
| `db/`      | senha de administrador do banco                               | banco, migrações (só leitura)    |
| `updater/` | chave das requisições assinadas                               | API e atualizador (só leitura)   |
| `backup/`  | chave das cópias e `rclone.conf`                              | só o serviço das cópias          |
| `forms/`   | senha e chave dos formulários                                 | formulários; migrações (leitura) |

- **Só o `init` vê o volume inteiro.** As cópias leem tudo, só leitura, porque sem a configuração
  inteira uma cópia não restaura.
- **Mudança de lugar sozinha:** numa instalação de antes das pastas, o `init` move cada arquivo
  para a sua pasta no próximo start, uma vez, sem gerar nada novo. A senha de administrador sai do
  arquivo da API. Se só uma das duas metades existir, ele para e pede a outra de uma cópia, em
  vez de criar uma senha que não abriria o banco.
- **Formulários falham fechados:** se a pasta deles tiver qualquer coisa além dos dois segredos
  deles (volume montado inteiro, sem `subpath`), o serviço não sobe.
- **Atualizador:** sai para o GitHub por uma rede só dele (`updater-out`), em vez da rede que a API,
  o antivírus, os formulários e as cópias também usam. Recusa requisição assinada antes de ele
  subir: os números já usados ficam só na memória, então um pedido capturado antes de um reinício
  não serve depois.
- **Restaurar** (`docs/RESTORE.md`): os volumes são criados sem ligar nada (`up --no-start`),
  para o banco nascer com a senha que voltou na cópia; pastas 700, arquivos 600.

**Por quê.** A API é o serviço exposto à internet. Antes, quem a tomasse levava junto a senha de
administrador do banco (que passa por cima de todas as regras de linha) e a chave das cópias.
Agora leva só o que ela já usa.

## D74 — Offline: lista que ela não vê mais sai do aparelho; um aparelho pode não guardar nada

**Decisão.**

- A cada estrutura nova (`/api/tree`), o aparelho apaga o que guardou de uma lista que sumiu,
  ficou sensível, ou mudou de nível ou de alcance desde que foi guardada. Uma recusa (403) ou um
  "não encontrado" (404) apaga o que havia daquela lista. Sem conexão, só abre lista que a
  última estrutura guardada ainda mostra.
- A estrutura guardada não leva as listas sensíveis, nem o nome delas.
- O vencimento de 7 dias apaga já ao abrir a página, mesmo que nada seja lido.
- Todas as abas apagam juntas (BroadcastChannel): uma aba que sai, ou é tirada, avisa as outras,
  que não guardam mais nada do que tinham pedido.
- "Minha conta" ganhou a seção "Este aparelho": desmarcar "Guardar neste aparelho o que eu
  abrir…" apaga tudo na hora e deixa aquele navegador sem guardar nada, para qualquer pessoa. A
  escolha é do aparelho (`localStorage`), não da conta.

**Por quê.** Antes, quem perdia uma lista (ou via a lista virar sensível) continuava com a última
leitura dela no aparelho até sair ou vencer. Agora o aparelho acompanha o acesso. Num computador
compartilhado, a pessoa decide que nada fica.

**O que sobra, por escrito** (`docs/design/pwa.md`, seção 3): abrir sem conexão não pede senha nem
código, e a chave mora no mesmo perfil do navegador que os dados.

## D75 — Autenticador só logo depois do convite; o fluxo ao vivo não conta como atividade; espaço reservado para os envios

**Decisão.**

- **Autenticador:** só é ligado com o desafio criado ao usar um convite ou um link de redefinição
  (`login_challenges.enrol`, criado pelo banco só no mesmo passo em que o convite é usado). Quem
  aceitou o convite e parou antes de ligar o autenticador não termina depois só com a senha: a
  entrada responde `authenticator_missing`, e a pessoa pede um novo link a um Dono ou ADM. O
  serviço de entrada só conta tentativas e consome desafios; não muda o resto.
- **Tempo ocioso:** abrir e conferir o fluxo ao vivo (`/api/events`) usa
  `authz.begin_request(token, ip, false)`, que valida a sessão sem renovar `last_seen_at`. Uma
  aba aberta sozinha não segura a sessão; a sessão vence no tempo ocioso e o fluxo fecha.
- **Anexos:** ao abrir um envio, o que ainda falta chegar de todos os envios abertos conta como
  ocupado (`app.uploads_open()`, só somas), além da folga de 512 MB. Cada parte confere o disco
  de novo. Uma pessoa tem no máximo cinco envios abertos ao mesmo tempo, na API e no banco.

**Por quê.** Quem tivesse só a senha de alguém que nunca ligou o autenticador poderia ligar o
dele. Uma aba esquecida aberta mantinha a sessão viva para sempre. E vários envios grandes
começados juntos passavam cada um na conferência de espaço, e somados enchiam o disco, que é o
mesmo do banco.

## D76 — A assinatura de uma versão precisa vir do commit da tag, no ramo principal

**Decisão.**

- O atualizador pergunta ao GitHub para qual commit a tag aponta e se esse commit está no ramo
  principal do repositório, antes de baixar qualquer arquivo da versão. Fora dele, recusa
  (`not_reviewed`); sem saber o commit, recusa (`origin_unknown`).
- O `cosign` confere, além da identidade e do emissor: o evento que disparou o fluxo (`release`),
  a referência (`refs/tags/<tag>`), o commit e o repositório (`--certificate-github-workflow-*`).
  Vale para o manifesto e para a imagem.
- O próprio `release.yml` se recusa a publicar uma tag cujo commit não está no ramo principal.
- O `release.yml` também publica e assina a imagem das cópias de segurança, e anexa à release o
  `cerebro-images.env`, com as linhas do `.env` (API, atualizador e cópias, por digest).

**Por quê.** A identidade `release.yml@refs/tags/<tag>` valia também para uma cópia alterada do
fluxo, sem o passo de aprovação, empurrada junto com uma tag nova. Amarrar a assinatura ao commit,
e o commit ao ramo principal, faz valer só o fluxo que passou por revisão.

**Fica com o mantenedor:** uma regra de tags no GitHub para que só mantenedores criem tags `v*`.
(Feito em 19/11, D82.)

## D77 — Antivírus preso, segredo que não fica copiado, e-mail de um endereço só, Trusted Types

**Decisão.**

- **Antivírus (ClamAV):** sem nenhuma permissão de root além das que o próprio contêiner usa para
  preparar as pastas e trocar para o usuário `clamav` (`cap_drop: ALL`, com CHOWN, DAC_OVERRIDE,
  FOWNER, SETGID e SETUID de volta), e numa rede de saída só dele (`clamav-out`), em vez da rede que
  a API, os formulários e as cópias também usam. Ele lê o que qualquer pessoa manda; se um arquivo
  o enganar, fica preso ali. O CI sobe o perfil `antivirus` e confere que o clamd responde assim.
- **Área de transferência:** copiar um campo secreto ou o link de um convite esvazia a área de
  transferência 30 segundos depois (ou quando a pessoa volta à página, se ela não estava na
  frente). A tela avisa.
- **E-mail:** um campo de e-mail aceita um endereço só, sem nenhum caractere que um link `mailto:`
  leia como assunto, corpo, cópia oculta ou outro destinatário. Valores guardados antes da regra
  continuam aparecendo, mas não viram link.
- **Trusted Types:** a política da página exige (`require-trusted-types-for 'script'`) que nenhum
  texto vire código, e só admite a política `cerebro`, que aceita um único endereço de script: o
  do service worker. O zod, que testava se podia gerar código (`Function('')`), roda sem isso na
  página (`@cerebro/shared/jitless`). O percurso em navegador agora trata qualquer bloqueio da
  política como problema, com o que foi bloqueado e onde.

**Por quê.** São os achados baixos da revisão independente. Nenhum abre acesso sozinho; cada um
fecha uma porta que, somada a outra falha, ajudaria quem ataca.

## D78 — Duas consultas que respondiam sobre qualquer coisa

**Decisão.** Saber se um item ainda segura subtarefas passou a ser perguntado sobre um item que
quem pergunta vê ("o pai deste item ainda serve?"), e não mais sobre qualquer item e qualquer
lista; a consulta antiga fica só para as rotinas do próprio banco. O título de um formulário, que
aparece no histórico de um item, só vai para quem vê a lista do formulário, como o nome de uma
regra (D72).

**Por quê.** Eram achados informativos da revisão: as duas respondiam sobre um identificador
qualquer. Ninguém chega a um identificador sem já ter visto o item, mas o banco não depende disso.

## D79 — Arquivo maior do que o antivírus aceita fica "não verificado"

**Decisão.** O ClamAV recusa um envio maior que o limite dele (`StreamMaxLength`, bem menor que
os 2 GB padrão dos anexos). Antes, esse arquivo ficava "em verificação" para sempre e era mandado
de novo ao antivírus a cada hora, inteiro. Agora ele fica "não verificado pelo antivírus", como na
instalação sem antivírus, e não volta para a fila. O envio ao antivírus também espera a rede: o
arquivo é lido no ritmo em que o antivírus recebe, e a leitura para assim que ele responde.

**Rever com o mantenedor.** A alternativa é bloquear esse arquivo em vez de liberá-lo com o aviso.
Para verificar arquivos maiores, sobe-se o limite do ClamAV (`StreamMaxLength`, `MaxFileSize`,
`MaxScanSize`, com mais memória) ou baixa-se `CEREBRO_MAX_ATTACHMENT_MB` para o mesmo valor.

## D80 — A senha dos papéis do banco chega já como verificador

**Decisão.** A migração não manda mais a senha dos papéis da API, da entrada e dos formulários num
`ALTER ROLE ... PASSWORD`. Ela calcula ali mesmo o verificador SCRAM-SHA-256 que o PostgreSQL
guarda (o mesmo que ele faria, conferido nos testes contra o próprio PostgreSQL) e manda só ele.
Senha de papel só com caracteres ASCII visíveis, sem espaço: para elas, a normalização que o
PostgreSQL aplica antes não muda nada.

**Por quê.** Um registro de comandos ligado no banco (para investigar um problema, por exemplo)
guardaria a senha em texto. O verificador não serve para entrar.

## D81 — Imagens de fora fixadas pelo hash

**Decisão.** Toda imagem de fora (Node, Docker, PostgreSQL, ClamAV), nos Dockerfiles, no Compose e
no CI, é referenciada pelo hash, além da tag. O CI reprova uma imagem nova sem hash. O Dependabot
propõe os hashes novos, inclusive das imagens do atualizador e das cópias, que ele não olhava, e
nenhuma versão nova (de pacote, ação ou imagem) é proposta antes de três dias publicada.

As versões maiores das ferramentas de desenvolvimento chegam em pull request próprio, fora do
grupo (a primeira leva juntou TypeScript 7 e os tipos do Node 26 com correções pequenas, e o CI
reprovou tudo junto), e os tipos do Node ficam na versão maior do Node que roda o Cérebro (22).

O PostgreSQL das cópias nunca pode ser mais antigo que o do banco: uma cópia feita no 16.16 não
abriu no 16.15 (um parâmetro que o 16.15 não conhece), e o teste de restauração do CI reprovou. O
Dependabot propõe as duas imagens em pull requests separados; trocar as duas juntas. Quando um
passo das cópias falha, o log do serviço agora diz a linha de erro do programa (só ela, curta).

**Por quê.** Uma tag pode passar a apontar para outra coisa; o hash, não. Era o último item da
blindagem que dependia de acesso ao Docker Hub.

## D82 — Proteções do repositório ligadas; dois informativos aceitos

**Decisão.** O mantenedor ligou no GitHub: relato privado de vulnerabilidades e alertas do
Dependabot (inclusive de malware); o ramo principal só recebe mudança por pull request com os seis
passos do CI passando, sem force push nem exclusão; só administradores criam, alteram ou apagam
tags; o ambiente `release` só roda com a aprovação do mantenedor e só a partir de tags de versão,
sem atalho para administradores; as ações precisam estar fixadas pelo hash; quem não é do
repositório só roda o CI depois de aprovado; o token dos fluxos é só de leitura.

Aprovação obrigatória num pull request fica em zero enquanto houver um mantenedor só: o GitHub não
deixa a mesma conta aprovar o próprio pull request, e a revisão é quem clica em "Merge".

Dois achados informativos ficam como estão, com o motivo:

- O fluxo ao vivo escuta um canal do banco (`LISTEN cerebro_live`) que qualquer conexão da API
  ouve. Por ele passam só identificadores (da lista, do item e das pessoas envolvidas), nunca
  título ou conteúdo; o conteúdo é sempre lido de novo com o acesso de quem está na página.
- Uma consulta com várias transações dentro poderia levar a identidade de uma para a outra. A API
  nunca monta consulta assim: cada pedido abre uma transação só, com a identidade amarrada a ela,
  e os valores vão sempre como parâmetros.

## D83 — Segunda revisão, página: o que fica no aparelho e nas outras abas

**Decisão.** Uma segunda revisão independente, só do que a Fase 11 mudou, achou na página:

- A página inicial guardada para ler offline não perdia o que veio de uma lista tirada da pessoa
  ou que virou sensível (títulos dos itens e o nome da lista). Agora, quando a estrutura nova
  chega, sai dela o que veio de lista que mudou, como já saíam os itens da própria lista; e, na
  leitura offline, ela mostra só o que a estrutura guardada ainda mostra.
- Quando alguém saía numa aba, as outras apagavam o que estava guardado, mas continuavam com a
  tela e o que tinham na memória. Agora sair, entrar ou a sessão acabar numa aba leva as outras
  para a entrada, sem nada na memória.
- A chave do autenticador e os códigos de recuperação também saem da área de transferência depois
  de 30 segundos. Quando o navegador recusa limpar (página fora da frente ou, em alguns
  navegadores, sem um clique ou tecla antes), a página tenta de novo no próximo clique, tecla ou
  volta à página. A tela agora diz "tenta limpar" e lembra que um histórico da área de
  transferência do sistema guarda uma cópia.
- `pwa.md` prometia que a cifragem protegia contra quem lê os arquivos do navegador; não protege
  (a chave fica nos mesmos arquivos). O texto foi corrigido.

## D84 — Segunda revisão, banco: tirar uma regra, alertas, convites, autenticador e envios

**Decisão.** A mesma segunda revisão achou no banco, todos corrigidos na migração 0049:

- **Tirar uma regra também abre.** Sem uma regra numa pasta ou lista, a pessoa volta para a regra
  da pasta de cima ou do espaço. Tirar a regra mais estreita entregava isso a ela, e quem tirava
  só precisava gerenciar o lugar. Agora tirar exige o mesmo que dar o que ela passa a ter (o nível
  e o alcance da regra para a qual volta), com as regras do próprio ADM abaixo contando (D72).
  Para quem não pode, a regra não aparece para tirar.
- **Alertas do serviço de entrada:** só os três que ele usa (bloqueio de entrada, código de
  recuperação usado, aparelho esperando), como aviso, com pouco anexo. Antes, um serviço tomado
  podia gravar qualquer alerta, inclusive um falso de cópia que esconderia os de verdade.
- **Convite vencido** não é usado, e **o aparelho esperando** diz quando pediu pelo relógio do banco.
- **O autenticador** só é gravado com um desafio vivo feito para vinculá-lo (que só usar um
  convite ou uma redefinição cria), salvo o do primeiro Dono durante a instalação. Depois disso o
  serviço de entrada só avança o último código usado; um autenticador confirmado não é trocado no
  lugar, e só sai quando um convite ou redefinição é usado.
- **Envios:** começam um de cada vez (a conta do espaço livre e a dos cinco envios abertos não se
  atropelam), uma pessoa não reserva mais que o dobro do maior arquivo permitido, e um envio parado
  há 15 minutos deixa de reservar espaço (sai com as rotinas, em 24 horas, como antes).
- **Donos e a primeira conta** só mudam em READ COMMITTED, o isolamento para o qual as travas
  foram escritas.
- **Uma lista que muda** (sensível, arquivada, movida, renomeada) é anunciada ao vivo, e as páginas
  abertas releem a estrutura, que poda o que ficou guardado no aparelho.

**Por quê.** Nenhum era crítico ou alto; o mais sério (tirar uma regra) desfazia em parte a D72.

## D85 — Segunda revisão, servidor: imagens assinadas, configuração, endereços e redes

**Decisão.** A segunda revisão achou no servidor, corrigido:

- **A lista de imagens da release** (`cerebro-images.env`), que o guia manda colar no `.env`, não
  era assinada, e nada conferia as imagens do atualizador e das cópias. Quem conseguisse trocar um
  anexo da release faria uma instalação nova rodar um atualizador dele, com acesso ao Docker do
  servidor. Agora o arquivo é assinado pelo fluxo de release, como o manifesto, e o guia de
  instalação manda conferir com o `cosign` (a mesma origem que o atualizador exige) antes de usar.
- **A API recusa subir em produção se enxerga mais da configuração do que a pasta dela e a do
  atualizador.** Um compose de antes das pastas por serviço (D73) montaria o volume inteiro, e a
  API rodaria com a senha de administrador do banco e a chave das cópias.
- **Endereços:** antes de entrar, a API conta pedidos por bloco IPv6 /64, como já contava o teto
  por endereço; os formulários também. O mapa desse teto tem limite de tamanho (passado o limite,
  os endereços novos dividem uma contagem).
- **Redes:** formulários e cópias saíram da rede da API (`edge`): cada um tem a sua. Um contêiner
  de formulários tomado não alcança mais a API para fingir ser o proxy. `CEREBRO_TRUST_PROXY`
  passa a ser configurável no `.env` (padrão 1).
- **Log das cópias:** valores da cópia que apareçam numa linha de erro são mascarados; nomes de
  tabela, coluna ou parâmetro ficam, porque dizem o que deu errado.

**Rever com o mantenedor (junto da D79).** O ClamAV, por padrão, diz "limpo" para um compactado
com arquivos acima dos limites dele ou cifrado. Ligar `AlertExceedsMax` e `AlertEncrypted` faria
esses casos serem bloqueados, ao custo de bloquear também compactados grandes ou com senha
legítimos. Fica para a mesma decisão da D79.

## D86 — O registro aceita cada entrada de quem pode dizê-la

**Decisão.** O registro (auditoria) aceitava qualquer uma das entradas da aplicação de qualquer
pessoa conectada, em nome dela. Agora o que uma atualização fez só entra por um Dono (só Donos veem
e rodam atualizações), e "abriu uma lista sensível" só por quem pode abrir aquela lista. As outras
entradas continuam como antes.

**Por quê.** A segunda revisão notou que um funcionário, pela API, podia registrar uma atualização
aplicada ou a abertura de uma lista que não vê. Ficava no nome dele, mas enganaria quem lê o
registro depois.

**Ficam como estão, com o motivo (achados informativos):**

- Quem vê só uma subtarefa fica sabendo, ao trazê-la da lixeira, se o pai que ela não vê também
  está na lixeira: é o que decide se ela volta debaixo dele ou sozinha.
- O título de um formulário vai para quem vê a lista dele mesmo se ela for sensível: o título é
  público (a página do formulário o mostra a qualquer um com o endereço).
- A auditoria de uma lista guarda o nome dela, inclusive de lista sensível, para quem pode ler o
  registro, como as outras tabelas já faziam.
- Quem edita uma lista sensível (com o código confirmado) pode mover os itens dela para outra:
  já podia ler e copiar o conteúdo.
- As rotinas do banco (sem identidade) rodam pela mesma conexão da API: uma API tomada as chamaria
  fora de uma requisição. Separar um papel só para elas fica para depois (**Rever com o
  mantenedor**).

## D87 — A API não escreve na própria pasta da configuração

**Decisão.** O token de instalação (de uso único, que reivindica uma instalação nova) ganhou uma
pasta própria no volume de configuração, `setup/`. A API monta a pasta dela (`api/`, com a chave
da instância e as senhas com que ela entra no banco) só para leitura, e escreve só na do token.
Uma instalação que tinha o token em `api/` o vê mudar de lugar no próximo start.

**Por quê.** A pasta `api/` era montada com escrita só por causa do token. A segunda revisão não
achou como uma API tomada tiraria proveito de reescrever `secrets.json` (as migrações o leem, mas
põem os valores entre aspas e o verificador da senha só aceita ASCII), mas não há motivo para
deixar a porta aberta. O CI confere que a API não escreve lá.

## Adiado, com motivo

| Item                                                  | Situação                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Passkeys / WebAuthn                                   | Opcional no plano; entra junto com a interface (precisa do navegador).                                       |
| CAPTCHA após falhas                                   | O bloqueio progressivo por conta e por endereço já existe; o CAPTCHA entra com a interface.                  |
| Restrição de login por país                           | Opcional; depende de base de geolocalização, a decidir na fase de implantação.                               |
| Alertas por e-mail e push                             | Os alertas já existem e são listados para os Donos; o push entra com o PWA (Fase 7, D51).                    |
| Checagem de senha vazada                              | Opcional; a política atual recusa senhas curtas, comuns ou com dados da pessoa.                              |
| Pré-visualização de PDF                               | O leitor de PDF do navegador não roda sob `sandbox`; por ora PDF só baixa (ver `docs/design/anexos.md`).     |
| Campos por espaço ou pasta                            | Ver D23: campos por lista com cópia que preserva a origem cobrem o uso; herança fica para depois.            |
| Nome de etapa de outra lista no "tempo em cada etapa" | Item que passou por outra lista mostra o nome da etapa onde esteve lá. Revisar junto com as visões (Fase 3). |
| Colunas configuráveis na lista                        | Hoje os quatro primeiros campos; a escolha por pessoa entra com as visões salvas (Fase 3).                   |
