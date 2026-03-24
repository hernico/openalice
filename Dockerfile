FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable \
    && corepack prepare pnpm@10.29.2 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && mkdir -p /opt/openalice/default-data /opt/openalice/seed-data \
    && cp -R data/default/. /opt/openalice/default-data/ \
    && cp -R deploy/vps/seed-data/. /opt/openalice/seed-data/ \
    && chmod +x /app/docker/entrypoint.sh

ENV NODE_ENV=production

EXPOSE 3002 3001 6901

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
