FROM node:22-slim
WORKDIR /app

COPY infra/sql/package.json ./package.json
COPY infra/sql/package-lock.json ./package-lock.json
COPY infra/sql/migrate.mjs ./migrate.mjs
COPY infra/sql/migrations ./migrations

RUN npm ci --omit=dev

USER node

CMD ["node", "migrate.mjs"]
