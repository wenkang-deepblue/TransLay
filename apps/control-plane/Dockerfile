FROM node:22-slim AS builder
WORKDIR /app

# Copy workspace root package files
COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json ./packages/shared-contracts/
COPY packages/shared-domain/package.json ./packages/shared-domain/
COPY packages/shared-config/package.json ./packages/shared-config/
COPY apps/control-plane/package.json ./apps/control-plane/

RUN npm ci --workspace=@translay/control-plane

# Copy shared packages source and build them
COPY packages/shared-contracts/ ./packages/shared-contracts/
COPY packages/shared-domain/ ./packages/shared-domain/
COPY packages/shared-config/ ./packages/shared-config/
RUN npm run build --workspace=@translay/shared-contracts && \
    npm run build --workspace=@translay/shared-domain && \
    npm run build --workspace=@translay/shared-config

# Copy and build control-plane
COPY apps/control-plane/ ./apps/control-plane/
RUN npm run build --workspace=@translay/control-plane

FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared-contracts/package.json ./packages/shared-contracts/
COPY packages/shared-domain/package.json ./packages/shared-domain/
COPY packages/shared-config/package.json ./packages/shared-config/
COPY apps/control-plane/package.json ./apps/control-plane/

RUN npm ci --workspace=@translay/control-plane --omit=dev

COPY --from=builder /app/packages/shared-contracts/dist ./packages/shared-contracts/dist
COPY --from=builder /app/packages/shared-domain/dist ./packages/shared-domain/dist
COPY --from=builder /app/packages/shared-config/dist ./packages/shared-config/dist
COPY --from=builder /app/apps/control-plane/dist ./apps/control-plane/dist

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/control-plane/dist/server.js"]
