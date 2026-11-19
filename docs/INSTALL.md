# Instalar numa empresa

Do servidor vazio até o primeiro Dono entrar, com marca, formulários e cópias de segurança. Cada
empresa tem a própria instalação: nada dela passa pelo repositório, e as chaves e senhas nascem no
servidor, no primeiro start.

> Antes de mexer num servidor que já tem outros sistemas, faça um snapshot dele.

## 1. O que é preciso

- **Um servidor Linux** com acesso SSH:
  - 2 vCPU, 4 GB de memória e 40 GB de disco bastam para uma equipe pequena;
  - com o antivírus dos anexos (ClamAV), conte 2 GB de memória a mais.
- **Docker Engine 26 ou mais novo**, com o plugin `docker compose`. Cada serviço monta só a sua
  pasta da configuração (volume com `subpath`, que só existe a partir do 26).
- **Dois nomes no DNS** apontando para o servidor. Os dois nunca são o mesmo:
  - um para o aplicativo, por exemplo `cerebro.exemplo.com`;
  - um para os formulários públicos, por exemplo `formularios.exemplo.com`.
- **Um proxy reverso com TLS** no próprio servidor. Os exemplos usam o [Caddy](https://caddyserver.com),
  que obtém e renova os certificados sozinho.
- **Para as cópias:** uma conta Google só para backups, com verificação em duas etapas, e espaço no
  Drive (Google One de 100 GB ou mais, conforme os anexos).

O firewall do servidor deixa entrar só 22, 80 e 443. Os serviços publicam portas só em
`127.0.0.1`, então nada deles fica exposto sem o proxy.

## 2. Pegar o código e as imagens

```sh
git clone https://github.com/<dono>/<repositório>.git /opt/cerebro/app
cd /opt/cerebro/app
git checkout v<versão>     # a versão publicada mais recente
```

Há duas formas de ter as imagens:

- **Com uma versão publicada (recomendado):** use as imagens assinadas da release, por digest, no
  `.env` do passo 3. Só elas podem ser atualizadas depois pelo próprio aplicativo.
- **Sem versão publicada ainda:** construa no servidor.

  ```sh
  docker build --file apps/api/Dockerfile --tag cerebro-api:local .
  docker build --file apps/backup/Dockerfile --tag cerebro-backup:local .
  ```

## 3. O arquivo `.env`

Crie `infra/.env`. O compose lê esse arquivo sozinho. Não ponha senha nenhuma nele: elas são
geradas no volume de configuração.

```sh
CEREBRO_PUBLIC_ORIGIN=https://cerebro.exemplo.com
CEREBRO_FORMS_ORIGIN=https://formularios.exemplo.com
TZ=America/Sao_Paulo

# Com versão publicada (senão, deixe de fora e valem as imagens :local do passo 2). As linhas
# certas, com os digests, vêm prontas no arquivo cerebro-images.env anexado a cada release:
CEREBRO_IMAGE=ghcr.io/<dono>/<repositório>/api@sha256:<digest>
CEREBRO_VERSION=<versão>
CEREBRO_UPDATER_IMAGE=ghcr.io/<dono>/<repositório>/updater@sha256:<digest>
CEREBRO_BACKUP_IMAGE=ghcr.io/<dono>/<repositório>/backup@sha256:<digest>

# Cópias de segurança (passo 7):
CEREBRO_BACKUP_STATUS=/opt/cerebro/backup-status/backup.json
CEREBRO_BACKUP_REPOSITORY=rclone:drive:cerebro-copias
```

`chmod 600 infra/.env` e o diretório `infra` pertencendo ao root.

## 4. Subir

```sh
docker compose --file infra/compose.yaml --profile forms up --detach --wait
```

No primeiro start, nesta ordem:

1. `init` gera a chave da instância e as senhas;
2. `postgres` nasce com a senha de administrador;
3. `migrate` cria o banco e as senhas dos três papéis de serviço;
4. a API e os formulários sobem.

Nada disso é sobrescrito nos starts seguintes. Conferir:

```sh
docker compose --file infra/compose.yaml ps
curl --silent http://127.0.0.1:3000/api/health      # {"status":"ok"}
```

## 5. Proxy reverso

O `Caddyfile` com os dois nomes:

```
cerebro.exemplo.com {
	reverse_proxy 127.0.0.1:3000
}

formularios.exemplo.com {
	reverse_proxy 127.0.0.1:3001
}
```

O Caddy repassa o `Host` original e o `X-Forwarded-For`, que os dois serviços usam. Também entrega
na hora os eventos de `/api/events` (atualização em tempo real). Com o Nginx, veja
`infra/README.md`, seção "Proxy reverso".

## 6. O primeiro Dono

1. Leia o token de instalação, de uso único:

   ```sh
   docker compose --file infra/compose.yaml exec api cat /opt/cerebro/config/api/setup-token
   ```

2. Abra `https://cerebro.exemplo.com`. Na tela **Instalar**:
   - cole o token;
   - informe o nome da empresa, o seu nome e o seu e-mail;
   - crie a senha.
3. Ligue o autenticador do celular (Google Authenticator, Microsoft Authenticator, Aegis ou outro)
   e confirme o código.
4. **Guarde os códigos de recuperação** fora do computador: no cofre de senhas e no papel.
5. **Deixe com a cara da empresa:** cor e logo (PNG, JPEG ou WebP; SVG não entra). Dá para pular e
   fazer depois, na página **Marca**.

O token some do servidor assim que o primeiro Dono existe: ninguém mais reivindica a instalação.

## 7. Cópias de segurança

1. Num computador com navegador e o [rclone](https://rclone.org) instalado, crie o acesso ao Drive
   da conta de backups:

   ```sh
   rclone config
   # n (novo) → nome: drive → tipo: drive → client_id e client_secret: em branco
   # scope: drive.file (o rclone só enxerga o que ele mesmo criou)
   # auto config: y → entre com a conta de backups no navegador
   ```

   O resultado fica em `~/.config/rclone/rclone.conf`.

2. Leve esse arquivo ao servidor e ponha na pasta `backup` do volume de configuração, que só o
   serviço das cópias monta:

   ```sh
   docker run --rm -v cerebro_config:/v -v "$PWD/rclone.conf:/r:ro" alpine \
     sh -c 'cp /r /v/backup/rclone.conf && chown 1000:1000 /v/backup/rclone.conf && chmod 600 /v/backup/rclone.conf'
   rm rclone.conf
   ```

3. Suba o backup já fazendo uma cópia e o teste de restauração:

   ```sh
   CEREBRO_BACKUP_NOW=backup+test docker compose --file infra/compose.yaml --profile backup up --detach
   ```

4. Em alguns minutos, a página **Segurança** mostra a última cópia e o teste de restauração: a cópia
   abriu, com quantas pessoas, e a trilha de auditoria íntegra.
5. **Guarde a chave das cópias** em dois lugares, como manda o `docs/RESTORE.md`, passo 1. Sem
   ela, nenhuma cópia abre.

Daí em diante: uma cópia por dia na hora de `CEREBRO_BACKUP_HOUR` (03h por padrão), guardadas por
um ano, e o teste de restauração todo dia 1. Se uma cópia falhar ou atrasar, os Donos recebem um
alerta.

## 8. Opcionais

- **Atualizar pelo aplicativo:** depende de uma versão publicada. Veja `infra/README.md`, seção
  "Atualizar pelo aplicativo".
- **Antivírus dos anexos:** enquanto `CEREBRO_ANTIVIRUS` estiver vazio, enviar anexos fica
  desligado. Veja `infra/README.md`, seção "Anexos e antivírus".

## 9. Conferir no fim

- [ ] `https://cerebro.exemplo.com` abre com cadeado, e `http://` leva para `https://`.
- [ ] `https://formularios.exemplo.com/api/me` responde "Não encontrado": o endereço dos
      formulários não serve nada do aplicativo.
- [ ] O token de instalação não existe mais:
      `docker compose --file infra/compose.yaml exec api ls /opt/cerebro/config/api` mostra só
      `secrets.json`.
- [ ] De fora do servidor, nenhuma porta além de 22, 80 e 443 responde.
- [ ] A página **Segurança** mostra a cópia e o teste de restauração, e "Verificar se o registro
      está íntegro" dá certo.
- [ ] Os códigos de recuperação do Dono e a chave das cópias estão guardados fora do servidor.
- [ ] Há pelo menos um segundo Dono ou ADM, para a empresa não depender de um celular só.

## 10. Quando algo não sobe

- **`migrate` falha:** `docker compose --file infra/compose.yaml logs migrate`. Cada migração roda
  numa transação: a que falhou não deixa nada pela metade. Corrija e suba de novo.
- **A página abre, mas nada funciona:** o endereço aberto precisa ser exatamente o de
  `CEREBRO_PUBLIC_ORIGIN`, com `https`. A API recusa pedidos de outra origem.
- **O formulário diz "Não encontrado":** confira se o proxy repassa o `Host` original e se
  `CEREBRO_FORMS_ORIGIN` é exatamente o endereço do formulário.
- **Nada sobe, e o erro fala do volume ou de `subpath`:** o Docker é anterior ao 26.
- **`forms` não sobe e diz que a pasta tem mais do que os segredos dele:** o volume foi montado
  inteiro, sem `subpath`. Ele se recusa a rodar assim de propósito.
- **Perdeu o celular do autenticador:** entre com um dos códigos de recuperação. Sem eles, outro
  Dono ou ADM libera um novo acesso na página **Pessoas**.
