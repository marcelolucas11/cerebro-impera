# Infraestrutura

`compose.yaml` descreve uma instalação: PostgreSQL e API numa rede interna sem rota para fora e,
se ligados, antivírus, atualizador, backup e formulários públicos.

> Para instalar numa empresa, do zero até o primeiro Dono, siga [`docs/INSTALL.md`](../docs/INSTALL.md).
> Este arquivo explica cada serviço e o que protege o quê.

## Subir localmente

```sh
docker build --file apps/api/Dockerfile --tag cerebro-api:local .
CEREBRO_PUBLIC_ORIGIN=https://cerebro.exemplo.test docker compose --file infra/compose.yaml up --detach
```

No primeiro start:

1. `init` gera os segredos da instância no volume `config` (chave e senhas do banco). Não existe
   senha padrão, e eles nunca são sobrescritos.
2. `postgres` nasce com a senha de administrador lida desse volume.
3. `migrate` aplica as migrações e define as senhas dos três papéis de serviço (API, entrada e
   formulários).
4. `api` sobe e, como ainda não há Dono, grava um token de instalação de uso único em
   `/opt/cerebro/config/setup-token`. Sem esse token ninguém consegue reivindicar a instalação:

   ```sh
   docker compose --file infra/compose.yaml exec api cat /opt/cerebro/config/setup-token
   ```

## Anexos e antivírus

Os anexos ficam no volume `files`, cifrados arquivo a arquivo; só a API o monta. Enquanto
`CEREBRO_ANTIVIRUS` estiver vazio, enviar anexos fica desligado. Para ligar com o ClamAV:

```sh
CEREBRO_ANTIVIRUS=clamd://clamav:3310 CEREBRO_PUBLIC_ORIGIN=https://cerebro.exemplo.test \
  docker compose --file infra/compose.yaml --profile antivirus up --detach
```

O ClamAV precisa de 1,2 a 1,5 GB de memória e leva alguns minutos no primeiro start para baixar
as assinaturas; até lá, os arquivos esperam "em verificação". `CEREBRO_ANTIVIRUS=off` liga os
anexos sem antivírus, e cada arquivo aparece como "não verificado pelo antivírus".

## O que protege o quê

| Medida                                                              | Efeito                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Rede `db` interna, banco sem `ports`                                | o PostgreSQL não é alcançável de fora nem alcança a internet          |
| Rede `scan` interna, antivírus sem `ports`                          | só a API fala com o antivírus; ele só sai para buscar assinaturas     |
| Volume `files` montado só na API, arquivos cifrados                 | uma cópia do disco não revela o conteúdo dos anexos                   |
| API publicada só em `127.0.0.1`                                     | só o proxy reverso do próprio servidor fala com ela                   |
| `read_only`, `cap_drop: ALL`, `no-new-privileges`, usuário sem root | uma falha na API não altera o código nem ganha privilégio no servidor |
| Segredos só no volume `config`                                      | nada sensível no repositório, na imagem ou em variáveis de ambiente   |
| Limites de memória e de processos                                   | um problema aqui não derruba outros sistemas no mesmo servidor        |

## Proxy reverso: endereço de quem chega

Os limites por endereço (tentativas de entrada, requisições por minuto, envios de formulário)
dependem de saber o endereço real de quem chega. A API confia só no número de proxies dito em
`CEREBRO_TRUST_PROXY` (normalmente 1) e lê o `X-Forwarded-For` da direita para a esquerda, então o
que o próprio cliente escrever nesse cabeçalho não conta. O Caddy já faz o certo. No Nginx, use
`proxy_set_header X-Forwarded-For $remote_addr;` (ou `$proxy_add_x_forwarded_for`, que também
funciona com 1 salto). Endereços IPv6 contam por bloco /64.

## Proxy reverso: atualizações em tempo real

A rota `/api/events` é um fluxo de eventos que fica aberto enquanto a página está aberta. O proxy
precisa repassar cada evento na hora, sem guardar em memória, e não pode cortar a conexão antes de
um minuto parada (a API manda um sinal a cada 25 segundos). No Nginx: `proxy_buffering off;` e
`proxy_read_timeout 120s;` nessa rota (a API também envia `X-Accel-Buffering: no`). O Caddy já
repassa na hora. Sem isso a página continua funcionando, só sem atualizar sozinha.

## Guardar com cuidado

O volume `config` contém a chave da instância. **Sem ela, os segundos fatores, os campos secretos
e os anexos não podem ser lidos**, e um backup do banco sozinho não basta para restaurar: o volume
`files` precisa ir junto.
Ela precisa de cópia própria, em lugar separado do backup do banco.

## Atualizar pelo aplicativo

O atualizador é opcional e fica no perfil `updater`. Ele é o único serviço com o socket do
Docker. Só a API fala com ele, por requisições assinadas com a chave `updater-key`, que o `init`
gera no volume de configuração. Ele só instala versões publicadas pelo fluxo `release.yml` do
repositório indicado e assinadas por ele. Desenho em `docs/design/atualizador.md`.

1. Neste diretório, o arquivo `.env` (que o compose lê sozinho) diz a imagem e a versão em uso,
   além das configurações da instalação. O atualizador troca só as duas primeiras linhas abaixo:

   ```sh
   CEREBRO_IMAGE=ghcr.io/<dono>/<repositório>/api@sha256:<digest da release>
   CEREBRO_VERSION=1.2.3
   CEREBRO_UPDATER_IMAGE=ghcr.io/<dono>/<repositório>/updater@sha256:<digest da release>
   CEREBRO_UPDATE_REPOSITORY=<dono>/<repositório>
   CEREBRO_UPDATER_URL=http://updater:8080
   CEREBRO_PUBLIC_ORIGIN=https://cerebro.exemplo.com
   ```

2. Suba com o perfil:

   ```sh
   docker compose --file infra/compose.yaml --profile updater up --detach
   ```

3. A seção **Atualizações** aparece para os Donos. "Procurar atualização" lê as releases.
   "Atualizar agora" pede o código do autenticador e faz o resto, nesta ordem:
   - copia o banco para o volume `backups`;
   - confere as assinaturas;
   - troca a imagem;
   - migra;
   - confere a saúde;
   - volta para a versão anterior se algo falhar.

Este diretório precisa pertencer ao root (o atualizador grava o `.env`). Antes de qualquer
mudança no servidor, faça um snapshot da VPS.

### Publicar uma versão (mantenedores)

1. No GitHub, crie o ambiente `release` com aprovação obrigatória de um mantenedor.
2. Publique uma release com a tag da versão (`v1.2.3`). O fluxo `release.yml` espera a aprovação.
   Depois disso:
   - constrói as imagens e as publica no GHCR por digest;
   - assina as imagens sem chave guardada;
   - gera o SBOM;
   - anexa à release o manifesto assinado.
3. `infra/release/min-from` diz a versão mais antiga de onde se pode chegar à nova. Suba esse
   número quando uma migração exigir uma versão intermediária.

## Cópias de segurança

O backup é opcional e fica no perfil `backup`. Todo dia, na hora de `CEREBRO_BACKUP_HOUR` (03h por
padrão, no fuso `TZ`), ele copia o banco, os anexos e a configuração para o repositório do restic
em `CEREBRO_BACKUP_REPOSITORY`. Tudo é cifrado antes de sair do servidor e guardado por um ano. No
dia 1 de cada mês, ele prova que a cópia restaura. Desenho em `docs/design/backup.md`; restauração
em `docs/RESTORE.md`.

```sh
# no .env deste diretório:
CEREBRO_BACKUP_IMAGE=ghcr.io/<dono>/<repositório>/backup@sha256:<digest>   # ou cerebro-backup:local
CEREBRO_BACKUP_STATUS=/opt/cerebro/backup-status/backup.json
CEREBRO_BACKUP_REPOSITORY=rclone:<remoto>:<pasta>   # sem isso, um volume local (só para testar)
TZ=America/Sao_Paulo

docker compose --file infra/compose.yaml --profile backup up --detach
```

- Para o Google Drive, use uma conta exclusiva para backups, com 2FA. Ponha o `rclone.conf` dela
  no volume de configuração (`/opt/cerebro/config/rclone.conf`, dono 1000, permissão 600).
- Copie a chave das cópias para o cofre e para o papel logo depois de instalar (`docs/RESTORE.md`,
  passo 1).
- Para conferir uma instalação nova, `CEREBRO_BACKUP_NOW=backup+test` faz uma cópia e o teste logo
  ao subir.

## Formulários públicos

Opcionais, no perfil `forms`. Cada lista pode ter formulários que qualquer pessoa com o endereço
preenche, e a resposta chega como item da lista. Eles ficam num endereço próprio (um subdomínio,
por exemplo `formularios.exemplo.com`), servido por um serviço à parte que só mostra e envia
formulários.

- O serviço monta só a pasta `forms` da configuração. Ela tem a senha de um papel do banco que não
  lê tabela nenhuma, só chama as funções dos formulários, e a chave do carimbo contra robôs.
- Ele não vê a chave da instância, as outras senhas nem os anexos.
- Precisa do Docker 26 ou mais novo (volume com `subpath`).

```sh
# no .env deste diretório:
CEREBRO_FORMS_ORIGIN=https://formularios.exemplo.com

docker compose --file infra/compose.yaml --profile forms up --detach
```

No proxy reverso, o subdomínio dos formulários aponta para `127.0.0.1:3001`, com TLS, e repassa o
`Host` original e o `X-Forwarded-For`. O endereço do aplicativo continua apontando para a porta 3000. Os dois nunca dividem o mesmo nome. Desenho em `docs/design/white-label.md`, seção 3.
