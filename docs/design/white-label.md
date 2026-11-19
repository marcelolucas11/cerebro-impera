# White label

Estado: **em construção** (Fase 10). Pronto: a marca da instalação (seção 2, D70).

Cada empresa que instala o Cérebro vê o próprio nome, logo e cor, sem mexer no código. O
repositório não traz a marca de nenhuma empresa: o que vem de fábrica é a marca do projeto.

## 1. O que já existia

- O nome da instalação (`instance_settings.instance_name`) é pedido na instalação e aparece no
  menu, nas telas de entrada, no autenticador e no manifesto.
- Todas as cores da página vêm de propriedades CSS (`--marca`, `--sobre-marca` e outras). As
  regras usam só as propriedades, então trocar a marca é trocar duas delas.
- A política de conteúdo da página (`APP_CONTENT_SECURITY_POLICY`) só aceita estilos e imagens
  servidos pela própria instalação, sem código inline.

## 2. Marca da instalação

**O que se escolhe:** nome (já existia), cor da marca e logo.

**Quem escolhe:** quem tem a permissão "Configurar o sistema" (`system.config`, o Dono sempre
tem), com o segundo fator confirmado há pouco. O banco recusa qualquer outra pessoa (RLS em
`instance_settings` e em `brand_images`). A primeira escolha fica no fim da instalação, num quarto
passo que dá para pular; depois, na página Marca.

**É pública.** Nome, cor e logo aparecem na tela de entrada, antes de qualquer senha, e no
manifesto. Por isso `/api/brand`, `/brand.css` e os ícones respondem sem sessão. Nada além disso
sai por esses endereços.

### Cor

- Formato `#rrggbb`, conferido no banco.
- O contraste com as superfícies da página (`--superficie`, a mais clara do fundo) precisa ser de
  pelo menos 4,5:1, porque a cor da marca também pinta texto. Uma cor escura demais some no fundo
  e é recusada com essa explicação. O contraste é conferido em `packages/shared`, pela tela antes de
  salvar e pela API ao salvar.
- O texto sobre a cor da marca (`--sobre-marca`) é calculado: a mesma cor escurecida, que sempre
  passa de 4,5:1 sobre ela.
- A cor chega à página por `/brand.css`, uma folha de estilo gerada só com as duas propriedades.
  O arquivo vem do mesmo endereço, então a política de conteúdo não muda, e a cor aparece já no
  primeiro desenho da página, sem piscar a cor de fábrica.

### Logo

O risco de um logo enviado é ele carregar código (SVG com script) ou bytes que algum programa
interprete de outro jeito. Por isso:

- **SVG nunca é aceito.** A tela aceita PNG, JPEG ou WebP, mas não envia o arquivo escolhido: ela
  o desenha num canvas e envia três PNG novos, gerados pelo navegador: 192×192, 512×512 e 512×512
  "maskable" (o logo dentro da área segura, sobre o fundo da página). Metadados da foto original
  (EXIF, localização) não chegam ao servidor.
- **A API confere cada PNG por inteiro**, sem biblioteca nova:
  - assinatura;
  - blocos com CRC correto;
  - só os tipos de bloco de imagem, sem texto nem metadados;
  - `IHDR` primeiro, com o tamanho exato esperado, 8 bits, RGB ou RGBA, sem entrelaçamento;
  - nada depois de `IEND`;
  - os dados descomprimidos com exatamente o tamanho que a imagem precisa, com teto na
    descompressão (sem "bomba" de compressão).

  Até 200 KB cada.

- **Servidos com** `Content-Type: image/png`, `X-Content-Type-Options: nosniff` e uma política de
  conteúdo que não permite nada (`default-src 'none'`), em endereços fixos (`/brand/icon-192.png`,
  `/brand/icon-512.png`, `/brand/maskable-512.png`). Sem logo próprio, esses endereços levam aos
  ícones de fábrica.
- **Onde aparece:** no menu, ao lado do nome; nas telas de entrada; como ícone da aba; no
  manifesto (ícone do aplicativo instalado).

### Auditoria

Trocar a cor ou o nome entra na trilha pelo gatilho que já existia em `instance_settings`. Trocar
ou tirar o logo entra com o tipo de imagem e o resumo (SHA-256), nunca com a imagem.

### Sem conexão

O service worker guarda `/brand.css` e os ícones da marca (nada pessoal) e os entrega quando a
rede falha. Com rede, sempre busca primeiro, para uma troca de marca chegar na próxima abertura.

## 3. Formulários num subdomínio que só envia

A desenhar na fatia 2: formulário público que cria item numa lista, num endereço separado que não
serve o aplicativo nem lê dados.

## 4. README de instalação

Fatia 3: do zero até o primeiro Dono, com marca, backup e atualizador, para outra empresa instalar
sem ajuda.

## 5. Ordem

1. ~~Marca da instalação (seção 2)~~ (D70).
2. Formulários (seção 3).
3. README de instalação (seção 4).
