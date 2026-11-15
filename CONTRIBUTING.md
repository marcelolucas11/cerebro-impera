# Como contribuir

Este projeto guarda informação sensível de empresas. As regras abaixo não são burocracia: cada uma
fecha um caminho real de vazamento.

## Regras que não têm exceção

1. **Nenhum dado real, de nenhuma empresa, entra no repositório.** Exemplos, sementes e testes usam
   dados fictícios e o domínio `exemplo.test`. Nada de dumps, exportações, prints, `.env`, chaves,
   tokens ou logs.
2. **Nada específico de uma instalação entra no código:** domínio, IP, nomes, marca, estrutura de
   listas. Isso é configuração, e configuração vive no servidor de cada instalação.
3. **Um segredo foi commitado por engano?** Troque o segredo imediatamente e avise os mantenedores.
   Apagar do histórico não resolve: o repositório é público.
4. **Toda regra de acesso vai nas duas camadas** (API e banco) e ganha teste nas duas: um pela API
   (`authorization.test.ts`) e um direto no banco (`database.test.ts`).
5. **Não escreva criptografia própria.** Use a biblioteca padrão da plataforma e as já adotadas.
6. **Tabela nova nasce com row-level security ligada**, e função com privilégio elevado nasce com
   `search_path` fixo e sem permissão para `PUBLIC`. Há testes que reprovam o contrário.
7. **Migração aplicada não se edita.** Crie uma nova.

## Fluxo

- Trabalhe em um branch e abra um pull request para `main`. Não há push direto.
- Commits assinados, pequenos e com mensagem que diga o que mudou e por quê.
- `pnpm check` precisa passar. O CI repete tudo e ainda varre segredos, dependências e o código
  (CodeQL).
- Dependência nova precisa de justificativa no PR. Scripts de instalação de pacotes ficam
  bloqueados por padrão (`onlyBuiltDependencies` em `pnpm-workspace.yaml`).
- Mudanças em `.github/` e em `apps/api/migrations/` pedem revisão redobrada: são as áreas que
  protegem todas as instalações.

## Falhas de segurança

Não vão em pull request nem em issue. Veja [`SECURITY.md`](SECURITY.md).
