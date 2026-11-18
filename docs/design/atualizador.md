# Atualizador pelo GitHub — desenho

Estado: **em construção** (Fase 8). Pronto: a página, as rotas e a conversa assinada com o
atualizador (seção 5, item 1). Nada aqui é específico de uma empresa: cada instalação aponta
para o repositório de onde aceita versões.

## 1. O que precisa valer

- Um Dono atualiza pelo aplicativo, com um botão, sem terminal. Nunca atualiza sozinho.
- Só entra uma versão publicada pelo fluxo de release **deste repositório**, assinada por ele.
  Imagem de outro lugar, versão mais antiga ou arquivo sem assinatura válida é recusado, e a
  recusa fica registrada.
- Antes de trocar a versão, um backup do banco. Se a versão nova não subir saudável, volta
  sozinha para a anterior, com o banco como estava.
- A API nunca tem acesso ao Docker. Quem tem é um serviço separado, o atualizador, que só fala
  com a API, por uma rede interna, com segredo próprio.
- Tudo na auditoria: quem pediu, de qual versão para qual, cada etapa e o resultado.

## 2. As peças

```
 GitHub (release publicada à mão)
   └─ fluxo release.yml: imagem → GHCR (por digest), assinatura cosign sem chave (OIDC),
      SBOM, e o manifesto cerebro-release.json assinado, anexado à release
                          │  só leitura, pela internet
                          ▼
 atualizador ── rede "updates" (interna) ── API ── página "Atualizações" (só Dono, código de novo)
   │ socket do Docker
   ▼
 docker compose: migrate, api (imagem por digest), postgres (backup antes)
```

- **Manifesto da versão** (`cerebro-release.json`): versão, digest da imagem, versão mínima de
  onde se pode chegar a ela e data. Assinado com `cosign sign-blob` pelo mesmo fluxo.
- **Identidade aceita:** certificado emitido para
  `https://github.com/<dono>/<repo>/.github/workflows/release.yml@refs/tags/<versão>` pelo emissor
  `https://token.actions.githubusercontent.com`. O repositório vem da configuração da instalação
  (`CEREBRO_UPDATE_REPOSITORY`). Sem ela, o atualizador não procura nada.

## 3. Atualizador (serviço próprio)

- Imagem mínima com o cliente do Docker e o `cosign`. Monta o socket do Docker e o diretório do
  `compose.yaml` (somente leitura). O único arquivo que escreve é `release.env`, com o digest da
  imagem em uso.
- Sem porta publicada. Fala só na rede `updates`, que só a API alcança. Toda requisição leva
  assinatura HMAC (chave gerada pelo `init` no volume de configuração), hora e número único. Fora
  de 60 segundos, ou com número repetido, é recusada.
- **Procurar:** lê as releases do repositório e pega a maior versão estável acima da atual. Baixa
  o manifesto e a assinatura e confere os dois com o `cosign`. Devolve versão, data e notas. As
  notas vão para a página só como texto, nunca como HTML.
- **Atualizar**, só para uma versão que acabou de passar na conferência:
  1. confere de novo o manifesto e a assinatura da imagem pelo digest;
  2. faz o backup do banco (`pg_dump` num contêiner descartável, no volume `backups`);
  3. baixa a imagem pelo digest e grava o digest novo em `release.env`;
  4. roda `migrate` e sobe `api` com a imagem nova;
  5. espera a API responder saudável (até 3 minutos);
  6. se falhar em qualquer passo depois do backup: para a API nova, restaura o backup, volta o
     digest anterior e sobe a versão anterior.
- Uma atualização por vez. O estado de cada etapa fica disponível para a API acompanhar.

## 4. API e página

- `GET /api/updates`: versão em uso, última procura, versão disponível e andamento. Só Dono.
- `POST /api/updates/check`: procura agora. Só Dono.
- `POST /api/updates/apply`: atualiza para a versão encontrada. Só Dono, com o código do
  autenticador confirmado de novo.
- Cada pedido e cada resultado vão para a auditoria (`update.checked`, `update.requested`,
  `update.applied`, `update.rolled_back`, `update.refused`).
- Sem atualizador configurado, a página diz isso e mostra a versão em uso.
- A página "Atualizações" mostra a versão em uso, o botão "Procurar atualização", a versão nova
  com as notas e o botão "Atualizar agora". Durante a atualização, a etapa em andamento; no fim,
  o resultado.

## 5. Ordem de construção

1. ~~Este desenho; versão em uso na API; tela e rotas, com o atualizador do outro lado da rede
   interna (nos testes, um atualizador de mentira que responde como o de verdade)~~ (D65).
2. O atualizador: procura, conferência da assinatura e passos da atualização, com testes que
   trocam o Docker, o GitHub e o `cosign` por versões de teste.
3. O fluxo de release (imagem, assinatura, SBOM, manifesto) e o `compose.yaml` com o serviço
   novo. Publicar a primeira release fica com o mantenedor.
