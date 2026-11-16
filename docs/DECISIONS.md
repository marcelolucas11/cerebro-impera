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

## Adiado, com motivo

| Item                        | Situação                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Passkeys / WebAuthn         | Opcional no plano; entra junto com a interface (precisa do navegador).                       |
| CAPTCHA após falhas         | O bloqueio progressivo por conta e por endereço já existe; o CAPTCHA entra com a interface.  |
| Restrição de login por país | Opcional; depende de base de geolocalização, a decidir na fase de implantação.               |
| Alertas por e-mail e push   | Os alertas já existem e são listados para os Donos; o envio entra com notificações (Fase 4). |
| Checagem de senha vazada    | Opcional; a política atual recusa senhas curtas, comuns ou com dados da pessoa.              |
