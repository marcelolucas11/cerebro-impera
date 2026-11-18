# Restaurar do zero

Para quando o servidor se perdeu, ou quando é preciso voltar a um dia anterior. Tudo que se
precisa é:

- o repositório das cópias (o volume local ou a pasta no Google Drive);
- a **chave das cópias** (`backup-password`), que o mantenedor guardou em dois lugares, no cofre de
  senhas e no papel.

Sem a chave, as cópias não abrem: ninguém consegue recuperá-la, nem quem fez o sistema.

> Antes de começar num servidor que ainda tem dados, faça um snapshot da VPS. Restaurar substitui
> o banco, os anexos e a configuração.

## 1. Guardar a chave (uma vez, logo depois de instalar)

```sh
docker compose --file infra/compose.yaml exec api cat /opt/cerebro/config/backup-password
```

Copie o resultado para o cofre de senhas e para um papel guardado longe do servidor. Ela não
aparece no aplicativo de propósito.

## 2. Ver as cópias que existem

Num computador ou servidor com o [restic](https://restic.net) instalado (e o rclone, se as cópias
estão no Google Drive):

```sh
export RESTIC_REPOSITORY='rclone:<remoto>:<pasta>'   # ou o caminho do repositório local
export RESTIC_PASSWORD_FILE=./backup-password         # o arquivo com a chave, só para você (chmod 600)
restic snapshots --tag cerebro
```

Cada linha é uma cópia, com data e identificador. As mais novas ficam no fim.

## 3. Trazer uma cópia

```sh
restic restore latest --tag cerebro --target ./restaurado
# ou um dia específico: restic restore <identificador> --target ./restaurado
```

Em `./restaurado` aparecem:

- `work/db.dump`: o banco, no formato do `pg_dump`;
- `data/files/`: os anexos, ainda cifrados, porque só abrem com a configuração abaixo;
- `data/config/`: a configuração da instância (chave mestra, senhas do banco, chave do
  atualizador e das cópias).

## 4. Subir a instalação com o que foi trazido

1. Num servidor novo, com o repositório do Cérebro e o Docker, crie os volumes subindo só o
   banco uma vez, e pare em seguida:

   ```sh
   docker compose --file infra/compose.yaml up --detach postgres
   docker compose --file infra/compose.yaml down
   ```

2. Ponha a configuração e os anexos de volta nos volumes, com o mesmo dono que a API usa (1000):

   ```sh
   docker run --rm -v cerebro_config:/v -v "$PWD/restaurado/data/config:/r:ro" alpine \
     sh -c 'cp -a /r/. /v/ && chown -R 1000:1000 /v && chmod 700 /v && chmod 600 /v/*'
   docker run --rm -v cerebro_files:/v -v "$PWD/restaurado/data/files:/r:ro" alpine \
     sh -c 'cp -a /r/. /v/ && chown -R 1000:1000 /v'
   ```

3. Suba o banco (ele usa a senha de administrador que voltou com a configuração) e restaure:

   ```sh
   docker compose --file infra/compose.yaml up --detach postgres
   docker compose --file infra/compose.yaml exec -T postgres \
     pg_restore --username postgres --dbname cerebro --clean --if-exists --single-transaction \
     < restaurado/work/db.dump
   ```

4. Suba o resto. `migrate` aplica as migrações mais novas, se a cópia for de uma versão anterior:

   ```sh
   docker compose --file infra/compose.yaml up --detach
   ```

5. Entre como Dono e confira:
   - a página Segurança, com "Verificar se o registro está íntegro";
   - uma lista com anexos;
   - um campo secreto, que deve abrir.

6. Apague `./restaurado` e o arquivo com a chave do computador onde trabalhou.

## 5. Se algo não abre

- **"wrong password" no restic:** a chave não é esta. Procure a outra cópia dela.
- **Anexos ou campos secretos não abrem:** a configuração restaurada não é a mesma do banco.
  Restaure as duas da mesma cópia.
- **O teste de restauração mensal falhou:** a página Segurança e o alerta dizem o motivo. Rode o
  passo 2 para ver se as cópias existem e o `restic check` para conferir o repositório.
