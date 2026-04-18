FROM node:22-slim AS builder
WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json ./packages/shared-contracts/
COPY packages/shared-domain/package.json ./packages/shared-domain/
COPY packages/shared-config/package.json ./packages/shared-config/
COPY apps/worker/package.json ./apps/worker/

RUN npm ci --workspace=@translay/worker

# Copy shared packages source and build them
COPY packages/shared-contracts/ ./packages/shared-contracts/
COPY packages/shared-domain/ ./packages/shared-domain/
COPY packages/shared-config/ ./packages/shared-config/
RUN npm run build --workspace=@translay/shared-contracts && \
    npm run build --workspace=@translay/shared-domain && \
    npm run build --workspace=@translay/shared-config

# Copy and build worker
COPY apps/worker/ ./apps/worker/
RUN npm run build --workspace=@translay/worker

FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json ./packages/shared-contracts/
COPY packages/shared-domain/package.json ./packages/shared-domain/
COPY packages/shared-config/package.json ./packages/shared-config/
COPY apps/worker/package.json ./apps/worker/

RUN npm ci --workspace=@translay/worker --omit=dev

COPY --from=builder /app/packages/shared-contracts/dist ./packages/shared-contracts/dist
COPY --from=builder /app/packages/shared-domain/dist ./packages/shared-domain/dist
COPY --from=builder /app/packages/shared-config/dist ./packages/shared-config/dist
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

# Runtime defaults must stay production-safe; secrets are injected at deploy time.
ENV NODE_ENV=production
ENV PORT=8080
ENV GCP_PROJECT_ID=YOUR_GCP_PROJECT_ID
ENV GCP_REGION=us-central1
ENV DB_HOST=127.0.0.1
ENV DB_PORT=5432
ENV DB_NAME=translay
ENV DB_USER=translay_app
ENV REDIS_HOST=127.0.0.1
ENV REDIS_PORT=6379
ENV CLOUD_TASKS_AUDIENCE=
ENV CLOUD_TASKS_INVOKER_SA=
ENV VERTEX_LOCATION=global

EXPOSE 8080
CMD ["node", "apps/worker/dist/server.js"]
