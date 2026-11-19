# syntax=docker/dockerfile:1

# Imagem do atualizador. O contexto de build é a raiz do repositório:
#   docker build --file apps/updater/Dockerfile --tag cerebro-updater:local .
#
# É o único serviço com acesso ao Docker (pelo socket montado no compose.yaml), então
# leva só o que precisa: Node, o cliente do Docker com o compose e o cosign.

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
ENV CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/updater/package.json apps/updater/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/updater/ apps/updater/
RUN pnpm --filter @cerebro/shared build \
 && pnpm --filter @cerebro/updater build \
 && pnpm --filter @cerebro/updater deploy --prod --legacy /out

FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS runtime
ARG TARGETARCH
# cosign em versão fixa, com o resumo conferido antes de entrar na imagem.
ARG COSIGN_VERSION=3.1.4
RUN apk add --no-cache nodejs \
 && case "${TARGETARCH}" in \
      amd64) sum=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa ;; \
      arm64) sum=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2 ;; \
      *) echo "arquitetura sem cosign conferido: ${TARGETARCH}" && exit 1 ;; \
    esac \
 && wget -q -O /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${TARGETARCH}" \
 && echo "${sum}  /usr/local/bin/cosign" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/cosign
ENV NODE_ENV=production \
    CEREBRO_CONFIG_DIR=/opt/cerebro/config \
    CEREBRO_COMPOSE_FILE=/opt/cerebro/compose/compose.yaml \
    CEREBRO_RELEASE_ENV=/opt/cerebro/compose/.env \
    CEREBRO_BACKUPS_DIR=/opt/cerebro/backups \
    CEREBRO_UPDATER_WORK=/var/lib/cerebro-updater
WORKDIR /app
COPY --from=build /out/ ./
RUN install -d -m 0700 /var/lib/cerebro-updater /opt/cerebro/backups
EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]
