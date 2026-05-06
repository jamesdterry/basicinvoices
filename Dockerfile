# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/basicinvoices.sqlite

# Litestream — pinned per WEBAPP_PLAYBOOK §6
ARG LITESTREAM_VERSION=v0.3.13
ADD https://github.com/benbjohnson/litestream/releases/download/${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-amd64.tar.gz /tmp/litestream.tgz
RUN tar -xzf /tmp/litestream.tgz -C /usr/local/bin litestream \
 && rm /tmp/litestream.tgz \
 && chmod +x /usr/local/bin/litestream

# Runtime libs needed by better-sqlite3 + chromium (Stage 6 PDF rendering
# uses puppeteer-core + @sparticuz/chromium; the Chromium binary needs the
# usual Debian X/font/sound stack even in headless mode).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
      fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY litestream.yml ./litestream.yml
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
