# syntax=docker/dockerfile:1

# Imagem da API. O contexto de build é a raiz do repositório:
#   docker build --file apps/api/Dockerfile --tag cerebro-api:local .

FROM node:22-bookworm-slim AS build
ENV CI=true
WORKDIR /repo
# pnpm na versão exata fixada em package.json ("packageManager").
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/updater/package.json apps/updater/
# Lockfile congelado; scripts de instalação de dependências seguem bloqueados.
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/
COPY apps/web/ apps/web/
COPY apps/updater/ apps/updater/
# Compila e separa só o que roda em produção (sem testes nem dependências de desenvolvimento),
# com a página pronta ao lado: é a própria API que a serve.
RUN pnpm -r build \
 && pnpm --filter @cerebro/api deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/web

FROM node:22-bookworm-slim AS runtime
# A versão vem da release que construiu a imagem; fora de uma release fica vazia ("dev").
ARG CEREBRO_VERSION=
ENV CEREBRO_VERSION=${CEREBRO_VERSION}
ENV NODE_ENV=production \
    CEREBRO_CONFIG_DIR=/opt/cerebro/config \
    CEREBRO_FILES_DIR=/opt/cerebro/files \
    CEREBRO_HOST=0.0.0.0 \
    CEREBRO_PORT=3000 \
    CEREBRO_WEB_ROOT=/app/web
WORKDIR /app
# O código pertence ao root e o processo roda como usuário sem privilégio: mesmo
# explorando uma falha na API, ninguém consegue alterar o código em execução.
COPY --from=build /out/ ./
# Únicos lugares graváveis: os segredos da instância, criados no primeiro start, e os
# anexos, guardados cifrados.
RUN install --directory --owner node --group node --mode 0700 /opt/cerebro/config /opt/cerebro/files
USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
