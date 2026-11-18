# Backup e restauração — desenho

Estado: **em construção** (Fase 9). Pronto: o serviço `apps/backup` (seção 6, item 1). Nada aqui é específico de uma empresa: cada instalação diz
para onde vão as cópias.

## 1. O que precisa valer

- Uma cópia completa por dia, de madrugada (03h no fuso da instalação). Ela inclui:
  - o banco;
  - os anexos (já cifrados arquivo a arquivo);
  - a configuração da instância, que é o que permite abrir os anexos e os segredos de novo.
- Tudo cifrado **antes** de sair do servidor. Quem tiver acesso ao destino (o Google Drive, por
  exemplo) vê só blocos cifrados.
- Guarda-se um ano: 30 diárias, 26 semanais e 12 mensais.
- Todo mês, uma restauração de verdade, num banco descartável, prova que a cópia abre e que os
  dados estão lá. O resultado vai para os Donos.
- Se a cópia falhar, ou passar mais de um dia sem cópia boa, os Donos são avisados no aplicativo.
- Passo a passo para restaurar do zero em `docs/RESTORE.md`.
- **A chave das cópias:** sem ela, as cópias não abrem. Ela é gerada no servidor, nunca aparece no
  aplicativo, e o mantenedor guarda uma cópia em dois lugares (cofre de senhas e papel).

## 2. As peças

- **Serviço `backup`** (`apps/backup`, perfil `backup` do `compose.yaml`). Imagem mínima com:
  - `restic` (cópias cifradas, com deduplicação e retenção);
  - `rclone` (destinos como o Google Drive);
  - o cliente e o servidor do PostgreSQL (o servidor só para o teste de restauração, dentro do
    próprio contêiner).

  Ele não tem o socket do Docker. Monta o volume de anexos e o de configuração somente para
  leitura e alcança o banco pela rede interna.

- **Destino** (`CEREBRO_BACKUP_REPOSITORY`): por padrão, um volume local, que serve para testar e
  não protege contra a perda do servidor. Para o Google Drive, `rclone:<remoto>:<pasta>`, com a
  configuração do rclone (conta de backup exclusiva, com 2FA) posta pelo mantenedor no volume de
  configuração. Ela nunca vai para o repositório.
- **Situação** (`backup.json` num volume só dele, lido pela API): última cópia (quando, se deu
  certo, o retrato, o tamanho e o problema) e último teste de restauração.

## 3. A cópia de cada dia

1. `pg_dump` em formato próprio do PostgreSQL.
2. `restic backup` do arquivo do banco, dos anexos e da configuração, com uma marca da instalação.
3. `restic forget --keep-daily 30 --keep-weekly 26 --keep-monthly 12 --prune`.
4. A situação é gravada. Se qualquer passo falhar, ela diz qual, em palavras, e a cópia anterior
   continua lá.

## 4. O teste de restauração de cada mês

No dia 1, depois da cópia:

1. `restic check`, para conferir que o repositório está íntegro.
2. Restaura o arquivo do banco da cópia mais recente num diretório temporário.
3. Sobe um PostgreSQL descartável dentro do contêiner (`initdb`, só local, sem rede) e aplica o
   `pg_restore`.
4. Confere que há pessoas e que a trilha de auditoria está íntegra (`audit.verify_chain()`).
5. Apaga tudo e grava o resultado na situação.

## 5. No aplicativo

- A página Segurança mostra, para quem vê a auditoria:
  - a última cópia e se deu certo;
  - a próxima;
  - o último teste de restauração.
- A rotina de hora em hora da API levanta um alerta de segurança (uma vez por dia) quando:
  - a última cópia falhou;
  - a última cópia boa tem mais de 26 horas;
  - o último teste de restauração falhou.

## 6. Ordem de construção

1. ~~Este desenho e o serviço `apps/backup`: cópia, retenção e teste de restauração, com testes que
   trocam `restic`, `pg_dump` e o PostgreSQL descartável por versões de teste~~ (D68).
2. Imagem, serviço no `compose.yaml`, chave gerada pelo `init`, situação na página, alertas e
   `docs/RESTORE.md`.
