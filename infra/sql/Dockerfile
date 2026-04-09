FROM node:22-slim
WORKDIR /app

COPY infra/sql/package.json ./package.json
COPY infra/sql/migrate.mjs ./migrate.mjs
COPY infra/sql/query.mjs ./query.mjs
COPY infra/sql/migrations ./migrations

RUN npm install --omit=dev

CMD ["node", "migrate.mjs"]
