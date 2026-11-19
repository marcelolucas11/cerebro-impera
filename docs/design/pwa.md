# Aplicativo instalável e modo offline — desenho

Estado: **pronto no código, menos o push** (Fase 7). Instalar e abrir sem conexão, ler offline o
que o aparelho guardou (cifrado), mudar itens offline com conferência no servidor e apagar à
distância. O push espera a decisão D51. Nada aqui
é específico de uma empresa.

## 1. O que precisa valer

- Instalável em celular e computador, com o nome da instalação (marca branca), sem loja.
- Abre sem conexão e diz isso com clareza. Nada é salvo em silêncio para depois sem que a pessoa
  saiba.
- Cada aparelho guarda só o que a pessoa já pode ver, e nunca:
  - listas sensíveis;
  - valores de campos secretos;
  - anexos;
  - o registro de auditoria.
- O que fica no aparelho fica cifrado, expira se o aparelho passar dias sem falar com o servidor e
  some quando a pessoa sai, quando a sessão é encerrada por outra pessoa ou quando um Dono manda
  apagar.
- Mudança feita offline é conferida pelo servidor quando volta, com as regras de sempre. Se outra
  pessoa mudou o mesmo campo nesse meio-tempo, ninguém perde nada em silêncio: as duas versões
  ficam no histórico e a pessoa vê o que aconteceu.

## 2. Instalar e abrir sem conexão (pronto)

- **Manifesto** (`/manifest.webmanifest`): a API o escreve com o nome da instalação, que a tela de
  entrada já mostra a qualquer um. Nada mais da instalação vai nele. Ícones em `apps/web/public/icons`
  (fontes e comando em `apps/web/icons/README.md`).
- **Service worker** (`/sw.js`): construído junto com a página (`vite.config.ts`), com a lista dos
  arquivos da página escrita dentro. A regra está em `apps/web/src/worker/policy.ts` e tem
  testes próprios:
  - guarda só a página (`/index.html`) e os arquivos com impressão digital (`/assets/`);
  - nunca toca em `/api/`: nenhuma resposta com dados passa por ele, nem é guardada;
  - abrir uma tela pede primeiro à rede (uma correção de segurança chega no próximo acesso); só
    sem rede ele entrega a página guardada;
  - cada versão nova apaga os arquivos das versões anteriores.
- **Sem conexão:** a página abre, diz "Sem conexão com o servidor" e tenta de novo sozinha (a cada
  poucos segundos e quando o aparelho avisa que a conexão voltou). Com o aplicativo aberto, uma
  faixa avisa que nada é salvo até a conexão voltar.

## 3. Dados offline (pronto, só leitura)

- **O que vai** (`apps/web/src/offline/policy.ts`, com testes):
  - a conta da pessoa;
  - a estrutura que ela vê, sem as listas sensíveis (nem o nome delas);
  - o Início, sem nada de lista sensível;
  - os itens, as etapas e os campos das listas não sensíveis que ela abriu.
    É sempre a última resposta do servidor, lida com o acesso dela, então quem vê só os próprios
    itens guarda só os próprios itens. Valores secretos nunca vêm junto com os itens, então nunca
    são guardados. Checklist e comentários ficam para a fila de mudanças.
- **Quando:** depois de cada resposta do servidor, e só depois que o servidor disse quem está
  conectado. Lido só quando o servidor não responde; a tela diz de quando são os dados.
- **Lista que ela não vê mais como antes:** a cada estrutura nova, sai do aparelho o que foi
  guardado de uma lista que sumiu, ficou sensível, ou mudou de nível ou de alcance (por exemplo,
  passou a ver só os próprios itens). O mesmo quando o servidor recusa ou não encontra uma lista
  (403 ou 404). Sem conexão, só abre lista que a última estrutura guardada ainda mostra.
- **Aparelho que não guarda nada:** em "Minha conta", seção "Este aparelho", a pessoa desmarca
  "Guardar neste aparelho…" num computador que outras pessoas usam. O que havia sai na hora e
  nada mais é guardado naquele navegador, para quem quer que entre nele.
- **Onde e como:** IndexedDB, cada registro cifrado com AES-GCM de 256 bits e um vetor novo por
  gravação. A chave é gerada no próprio aparelho pelo WebCrypto, marcada como não exportável, e
  guardada no IndexedDB. Nenhum código da página consegue ler os bytes da chave, só usá-la.
- **Limite honesto:** a chave fica no perfil do navegador. Quem copiar o perfil inteiro de um
  aparelho desbloqueado leva a chave junto, como já levaria o cookie de sessão. A cifragem protege
  contra ferramentas que leem o disco, cópias de segurança e sincronizações que pegam os arquivos
  do navegador. A defesa contra aparelho perdido é a soma de:
  - criptografia de disco do sistema;
  - expiração;
  - encerramento da sessão por um Dono;
  - apagamento remoto.
    Assim está pedido no roteiro do projeto.
- **Expiração:** sem falar com o servidor por 7 dias, o aparelho apaga tudo, já ao abrir a
  página (não só quando tenta ler). Tornar o prazo ajustável pelo Dono fica para quando houver
  configurações da instalação na tela.
- **O que sobra:** abrir sem conexão não pede senha nem código. Quem pega um aparelho
  desbloqueado, dentro dos 7 dias, lê o que ele guardou das listas não sensíveis. Para isso
  existem o bloqueio de tela do próprio aparelho, a opção de não guardar e o apagamento remoto.
- **Apagado** (a chave junto):
  - ao sair, antes mesmo de avisar o servidor (sair sem conexão também apaga);
  - quando o servidor responde que a sessão acabou;
  - ao entrar, para ninguém herdar o que outra pessoa deixou no aparelho;
  - quando um Dono manda apagar (seção 4).
    Uma resposta pedida antes de apagar e que chega depois é descartada. Todas as abas abertas
    apagam juntas: a que apaga avisa as outras (BroadcastChannel), que largam o que têm na memória.

## 4. Apagamento remoto (pronto)

- Qualquer resposta "sem sessão" do servidor (401) apaga, antes de qualquer outra coisa, o que o
  aparelho guardou, a chave junto. Isso acontece quando:
  - a sessão vence;
  - quem aprova aparelhos revoga o aparelho;
  - a pessoa encerra aquela sessão em "Minha conta" ou troca a senha;
  - um Dono suspende a conta.
- Vale também ao abrir a página: um aparelho revogado apaga tudo na primeira tentativa de entrar
  e, sem conexão, já não abre nada.
- Revogar é a ordem de apagar: a sessão daquele aparelho acaba na hora, e o servidor nunca mais o
  aceita sem nova aprovação. A ordem fica na auditoria (`device.revoked`).
- **O que não dá para fazer:** um aparelho que nunca mais se conectar não recebe a ordem. Para
  esse caso valem a expiração de 7 dias e a criptografia de disco do sistema. O servidor não
  recebe confirmação do apagamento: o aparelho não tem mais sessão para mandá-la.

## 5. Mudanças feitas sem conexão (pronto)

- **O que pode:** etapa, título, prazo e prioridade de um item que o aparelho guardou. O resto
  (campos, responsáveis, checklist, comentários, anexos) continua pedindo conexão e diz isso.
- **Como espera:** a mudança vai para uma fila no próprio aparelho, cifrada como o resto e apagada
  junto com ele. Cada mudança leva o que a pessoa via antes de fazê-la. A lista guardada já mostra
  a mudança, e uma faixa diz quantas esperam.
- **Quando a conexão volta:** a fila é enviada em ordem, com as regras de sempre do servidor:
  - se ninguém mudou aquilo nesse meio-tempo, entra como qualquer mudança, com histórico;
  - se outra pessoa mudou o mesmo campo, o servidor não escreve nada e responde com o valor de
    agora (`changed_meanwhile`). A pessoa vê as duas versões e escolhe: "Manter a minha" (entra
    por cima, e as duas ficam no histórico) ou "Ficar com a de lá";
  - se o servidor recusar (acesso perdido, etapa restrita, item na lixeira), a mudança aparece
    como não aceita, com o motivo, até a pessoa dar ciência.
- **Nada some em silêncio**, com uma exceção escrita: sair ou ter a sessão encerrada apaga também
  o que não foi enviado, porque nada de uma sessão encerrada pode ficar no aparelho.

## 6. Ordem de construção

1. ~~Instalar e abrir sem conexão~~ (D61).
2. ~~Dados offline cifrados, só leitura, com expiração e apagamento ao sair ou perder a sessão~~ (D62).
3. ~~Apagamento remoto por aparelho~~ (D63).
4. ~~Fila de mudanças offline (etapa, título, prazo e prioridade), conferida no servidor, com
   conflito por campo~~ (D64). Checklist e comentário offline ficam para depois.
5. Avisos no celular (push), quando o mantenedor decidir quais avisos cada pessoa recebe (D51).
   O conteúdo não sai pelo serviço de push: a notificação diz só que há avisos novos, e o
   aplicativo busca o resto direto no servidor.
