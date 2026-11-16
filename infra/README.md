# Infraestrutura

`compose.yaml` descreve uma instalação: PostgreSQL e API, numa rede interna sem rota para fora.

> A implantação guiada (proxy reverso com TLS, backup, atualizador) chega nas fases 8, 9 e 12. Por
> enquanto isto serve para desenvolvimento e para o CI provar que a imagem sobe.

## Subir localmente

```sh
docker build --file apps/api/Dockerfile --tag cerebro-api:local .
CEREBRO_PUBLIC_ORIGIN=https://cerebro.exemplo.test docker compose --file infra/compose.yaml up --detach
```

No primeiro start:

1. `init` gera os segredos da instância no volume `config` (chave e senhas do banco). Não existe
   senha padrão, e eles nunca são sobrescritos.
2. `postgres` nasce com a senha de administrador lida desse volume.
3. `migrate` aplica as migrações e define as senhas dos dois papéis da API.
4. `api` sobe e, como ainda não há Dono, grava um token de instalação de uso único em
   `/opt/cerebro/config/setup-token`. Sem esse token ninguém consegue reivindicar a instalação:

   ```sh
   docker compose --file infra/compose.yaml exec api cat /opt/cerebro/config/setup-token
   ```

## O que protege o quê

| Medida                                                              | Efeito                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Rede `db` interna, banco sem `ports`                                | o PostgreSQL não é alcançável de fora nem alcança a internet          |
| API publicada só em `127.0.0.1`                                     | só o proxy reverso do próprio servidor fala com ela                   |
| `read_only`, `cap_drop: ALL`, `no-new-privileges`, usuário sem root | uma falha na API não altera o código nem ganha privilégio no servidor |
| Segredos só no volume `config`                                      | nada sensível no repositório, na imagem ou em variáveis de ambiente   |
| Limites de memória e de processos                                   | um problema aqui não derruba outros sistemas no mesmo servidor        |

## Guardar com cuidado

O volume `config` contém a chave da instância. **Sem ela, os segundos fatores e os campos secretos
guardados no banco não podem ser lidos**, e um backup do banco sozinho não basta para restaurar.
Ela precisa de cópia própria, em lugar separado do backup do banco.
