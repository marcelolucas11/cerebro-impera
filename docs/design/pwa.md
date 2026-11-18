# Aplicativo instalável e modo offline — desenho

Estado: **em construção** (Fase 7). A primeira parte está pronta: instalar e abrir sem conexão.
Os dados offline, a fila de mudanças e o apagamento remoto seguem a ordem da seção 5. Nada aqui
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

## 3. Dados offline (próxima parte)

- **O que vai:** as listas não sensíveis que a pessoa abriu nos últimos dias ou fixou no Início:
  itens, etapas, campos (sem o valor dos secretos), checklist e comentários. Lido com o acesso
  dela, como na tela; quem vê só os próprios itens guarda só os próprios itens.
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
- **Expiração:** sem falar com o servidor por 7 dias (ajustável pelo Dono), o aparelho apaga tudo e
  pede a entrada de novo.
- **Apagado:**
  - ao sair;
  - quando o servidor responde que a sessão acabou;
  - quando o aparelho é desaprovado;
  - quando um Dono manda apagar (seção 4).

## 4. Apagamento remoto

- Um Dono (ou quem aprova aparelhos, abaixo dele na hierarquia) marca um aparelho para apagar. No
  próximo contato, o servidor responde com a ordem e a página apaga o IndexedDB, os caches e o
  service worker antes de qualquer outra coisa. A ordem fica no registro de auditoria, e a
  confirmação também.
- A sessão daquele aparelho é encerrada junto, então o cookie deixa de valer mesmo que a página
  nunca mais abra.

## 5. Ordem de construção

1. ~~Instalar e abrir sem conexão~~ (D61).
2. Dados offline cifrados, só leitura, com expiração e apagamento ao sair ou perder a sessão.
3. Apagamento remoto por aparelho.
4. Fila de mudanças offline (etapa, título, prazo, prioridade, checklist e comentário), conferida
   no servidor, com conflito por campo.
5. Avisos no celular (push), quando o mantenedor decidir quais avisos cada pessoa recebe (D51).
   O conteúdo não sai pelo serviço de push: a notificação diz só que há avisos novos, e o
   aplicativo busca o resto direto no servidor.
