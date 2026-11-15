# Política de segurança

## Como relatar uma falha

**Não abra issue, discussão ou pull request públicos para falhas de segurança.** Enquanto a correção
não é publicada, um relato público expõe todas as instalações.

Use o relato privado do GitHub: aba **Security** deste repositório → **Report a vulnerability**.
Só os mantenedores veem o conteúdo.

Inclua, se possível: versão ou commit, o que um atacante consegue fazer, passos para reproduzir e
qualquer prova de conceito. **Nunca envie dados reais de uma instalação** (dumps, prints com
informação de clientes, chaves).

## O que esperar

- Confirmação de recebimento em até 3 dias úteis.
- Avaliação e plano de correção em até 10 dias úteis.
- Correção publicada junto com um aviso de segurança; o crédito é seu, se você quiser.

Pedimos 90 dias de sigilo, ou até a correção ser publicada, o que vier primeiro.

## Versões com suporte

Enquanto o projeto não tem versão estável, só a versão mais recente recebe correções.

## Escopo

Interessa especialmente qualquer forma de:

- ver ou alterar dados sem a permissão correspondente (entre funcionários, entre áreas, de fora);
- elevar o próprio papel, capacidades ou concessões;
- entrar sem segundo fator ou em dispositivo não aprovado, ou manter acesso após revogação;
- editar, apagar ou forjar entradas da trilha de auditoria sem que a verificação acuse;
- fazer uma instalação aceitar uma atualização que não saiu deste repositório;
- obter segredos da instância a partir da API.

Fora de escopo: ataques que exigem acesso de administrador ao servidor ou ao sistema operacional da
vítima, engenharia social e negação de serviço por volume.

---

**English:** please report vulnerabilities privately through GitHub (Security tab → _Report a
vulnerability_), never in a public issue. Do not include real data from any installation.
