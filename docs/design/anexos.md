# Anexos — desenho

Estado: **construído** (migração `0017_attachments.sql`, API, tela e passo no percurso em
navegador), com uma decisão pendente: qual antivírus a instalação usa (seção 6).
Este documento descreve como arquivos entram, ficam guardados e saem do sistema. Nada aqui é
específico de uma empresa.

## 1. O que precisa valer

- Anexo segue o item: quem vê o item baixa os anexos dele; quem edita o item anexa e remove.
  Funcionário que vê só os próprios itens nunca vê anexo de item alheio, nem o nome do arquivo.
- Lista sensível: baixar pede o 2º fator recente, como abrir a lista, e cada download fica no
  registro de auditoria.
- Qualquer tipo de arquivo (imagem, documento, áudio, vídeo), até 2 GB por arquivo por padrão,
  limite configurável na instalação.
- Envio retomável: uma conexão de celular que cai no meio continua de onde parou.
- Nada que veio de fora roda na página do sistema. Um arquivo nunca é tratado como página.
- Arquivo guardado cifrado. Uma cópia do disco, sozinha, não revela nada.
- Nada é apagado de imediato: anexo removido vai para a lixeira por 30 dias, como os itens.

## 2. Onde os arquivos ficam

- Num volume próprio da instalação (`files`), fora do banco de dados. O banco guarda só os dados
  de cada anexo: item, nome, tamanho, tipo informado, tipo detectado, resumo SHA-256, situação,
  quem enviou e quando.
- No disco, o nome de cada arquivo é um identificador aleatório, sem nome original nem extensão.
- O volume não é acessível por nenhum outro serviço; só o contêiner da API o monta.

## 3. Cifragem

- Cada arquivo tem uma chave própria de 256 bits, aleatória. Essa chave é guardada no banco
  cifrada com a chave da instância (o mesmo cofre que já protege os segredos do 2º fator).
- O conteúdo é cifrado em segmentos de 8 MiB com AES-256-GCM, cada segmento com o próprio número
  único e a própria marca de autenticidade, ligados à posição do segmento e ao identificador do
  anexo. Trocar, reordenar ou cortar segmentos é detectado na leitura.
- Segmentos casam com o envio retomável: cada parte recebida é cifrada e gravada como um
  segmento, sem precisar juntar o arquivo inteiro em memória ou em disco aberto.

## 4. Envio retomável

1. `POST /api/items/:id/attachments` com nome, tamanho e tipo informado. Confere permissão,
   limite de tamanho e espaço livre em disco. Devolve o identificador do envio e o tamanho das
   partes (8 MiB).
2. `PUT /api/uploads/:id/parts/:n` com o conteúdo bruto da parte. Cada parte é cifrada e gravada
   na hora. Repetir uma parte já recebida é permitido (a última vale).
3. `GET /api/uploads/:id` diz o tamanho das partes e quais já chegaram: é como o envio continua
   depois de cair. Na tela, uma parte que falha por falta de conexão é tentada de novo sozinha
   (até 4 vezes, esperando 1, 2 e 4 segundos); depois disso o envio para e mostra "Continuar
   envio". Se a página foi fechada, o envio aparece como "envio interrompido" para quem o
   começou: escolher o mesmo arquivo (mesmo nome e tamanho) continua de onde parou.
4. `POST /api/uploads/:id/finish` confere que todas as partes chegaram, que o tamanho bate e
   calcula o SHA-256. O anexo passa a "em verificação".

- Envio parado por 24 horas é descartado com tudo o que já tinha chegado.
- Só quem começou o envio continua, termina ou cancela.

## 5. Saída: baixar e pré-visualizar

- `GET /api/attachments/:id/content`, com a sessão normal (mesma origem, cookie `SameSite=Strict`).
  Não existe link público. Se um dia for preciso compartilhar fora do sistema, será um link de
  validade curta e uso contado, decidido à parte.
- Toda resposta de arquivo leva `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` e
  `Content-Security-Policy: default-src 'none'; sandbox`.
- Por padrão o arquivo vem como download (`Content-Disposition: attachment`), com o nome
  original codificado com segurança.
- Pré-visualização na própria página só para tipos que não executam nada, e sempre pelo tipo
  detectado no conteúdo, nunca pelo nome nem pelo que o navegador informou: PNG, JPEG, WebP, GIF,
  MP3, M4A, OGG, WAV, MP4, WebM. SVG, HTML e qualquer outro tipo sempre vêm como download.
- **PDF vem só como download, por enquanto.** O leitor de PDF do navegador executa código próprio
  e não funciona sob `sandbox`; afrouxar a política só para ele não vale o risco agora. Revisar
  quando houver um leitor de PDF que rode dentro da própria página (Fase 3 ou depois).
- Abrir a pré-visualização ou baixar passa antes por `GET /api/lists/:lista/attachments/:id`,
  que confere o acesso pela lista. Numa lista sensível sem 2º fator recente, a resposta é "confirme
  o código" (e a tela pede o código), em vez de "não encontrado". Essa consulta não conta como
  download no registro de auditoria.
- Suporte a pedidos de intervalo (`Range`) para áudio e vídeo tocarem sem baixar tudo.

## 6. Antivírus — decisão pendente

Proposta: ClamAV (serviço `clamd` na rede interna da instalação, sem acesso à internet além da
atualização das assinaturas). O arquivo é enviado ao `clamd` por fluxo depois do envio terminar.

- Limpo: "disponível".
- Infectado: "bloqueado". Ninguém baixa; os Donos recebem alerta; o arquivo fica 30 dias para
  conferência e depois é apagado.
- Enquanto não foi verificado, ninguém baixa, nem quem enviou.
- Antivírus fora do ar: o arquivo continua "em verificação" (nunca vira "limpo" por falta de
  resposta) e é entregue de novo ao antivírus a cada hora e quando o serviço reinicia, sem
  verificar o mesmo arquivo duas vezes ao mesmo tempo.
- Arquivo maior do que o antivírus aceita (`StreamMaxLength` do ClamAV, bem menor que os 2 GB
  padrão dos anexos): fica "não verificado pelo antivírus", como sem antivírus, e não volta para
  a fila (D79). Para verificar arquivos maiores, suba `StreamMaxLength`, `MaxFileSize` e
  `MaxScanSize` no ClamAV (custa memória) ou baixe `CEREBRO_MAX_ATTACHMENT_MB` para o mesmo
  limite.

**O que falta decidir (mantenedor):** o ClamAV usa de 1,2 a 1,5 GB de memória. Depende da
configuração da VPS. Alternativas, da mais segura para a menos:

1. ClamAV na mesma VPS (recomendado, se houver memória livre).
2. ClamAV numa VPS pequena separada, só na rede privada.
3. Sem antivírus: anexos ficam "não verificados", com aviso ao baixar, e a instalação registra
   que o Dono escolheu esse modo.

Como ficou no código, à espera da decisão: a variável `CEREBRO_ANTIVIRUS` escolhe.

| Valor                 | Efeito                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| vazio (padrão)        | anexos desligados: a tela explica que falta escolher o antivírus              |
| `clamd://clamav:3310` | ClamAV; `infra/compose.yaml` traz o serviço, ligado com `--profile antivirus` |
| `off`                 | sem antivírus: tudo fica marcado "não verificado pelo antivírus"              |

Os testes usam um verificador falso que reconhece o arquivo de teste padrão EICAR; o percurso em
navegador roda com `off`. Falta, para a opção 3: o sistema registrar que essa foi a escolha do Dono
(entra com as configurações da instalação, Fase 10); hoje a escolha fica só na configuração do
servidor.

## 7. Lixeira, histórico e cópias de segurança

- Remover um anexo manda para a lixeira por 30 dias; depois, o banco remove o registro e o
  serviço apaga os segmentos.
- Item que vai para a lixeira leva os anexos; item removido de vez leva tudo.
- O histórico do item registra anexo enviado, removido e restaurado.
- O volume `files` entra nas cópias de segurança (Fase 9), já cifrado.
- Nada de anexo vai para o modo offline (Fase 7).

## 8. Fora deste desenho

- Gravação de áudio pelo celular (usa este mesmo envio quando vier).
- Campo do tipo "arquivo": será um campo que aponta para anexos do item, depois desta base.
- Edição de documentos dentro do sistema.
