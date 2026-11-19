# syntax=docker/dockerfile:1

# Imagem do serviço de backup. O contexto de build é a raiz do repositório:
#   docker build --file apps/backup/Dockerfile --tag cerebro-backup:local .
#
# Parte da imagem oficial do PostgreSQL 16: o cliente (pg_dump) é da mesma versão do banco, e o
# servidor serve só para o teste de restauração, dentro do próprio contêiner, sem rede. restic e
# rclone vêm dos pacotes assinados do Alpine. Não tem o socket do Docker.

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
ENV CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/backup/package.json apps/backup/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/backup/ apps/backup/
RUN pnpm --filter @cerebro/shared build \
 && pnpm --filter @cerebro/backup build \
 && pnpm --filter @cerebro/backup deploy --prod --legacy /out

# Nunca mais antiga que a do banco (infra/compose.yaml): uma cópia feita num PostgreSQL mais novo
# pode não abrir num mais antigo, e o teste de restauração reprova. Trocar as duas juntas.
FROM postgres:16.16-alpine@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e AS runtime
RUN apk add --no-cache nodejs restic rclone \
 # O mesmo número de usuário da API: lê os segredos que ela gerou (0600), e o initdb não
 # aceita rodar como root.
 && adduser -D -H -u 1000 cerebro \
 && install -d -o cerebro -g cerebro -m 0700 /work /repo \
 && install -d -o cerebro -g cerebro -m 0755 /status
ENV NODE_ENV=production \
    CEREBRO_CONFIG_DIR=/data/config \
    CEREBRO_BACKUP_STATUS=/status/backup.json \
    RESTIC_CACHE_DIR=/work/.cache \
    HOME=/work
WORKDIR /app
COPY --from=build /out/ ./
USER cerebro
ENTRYPOINT ["node", "dist/main.js"]
