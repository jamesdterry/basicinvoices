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

# Runtime libs. PDF rendering is now pure-JS via pdfkit, so the Chromium
# X/font/sound stack that Stage 6 used is gone — only the basics remain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini sqlite3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY litestream.yml /etc/litestream.yml
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/docker-entrypoint.sh"]
