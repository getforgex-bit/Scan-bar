# Imagen de Scan-bar (API + PWA + resolver) para Cloudflare Containers o cualquier servidor con Docker.
# La base de datos es un PostgreSQL administrado (Neon, Supabase…) que llega por DATABASE_URL.

# 1) Compilar la PWA
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 2) Imagen final: solo dependencias de producción; git para sincronizar el catálogo de las webs
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 TRUST_PROXY=1
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/api ./apps/api
COPY packages ./packages
COPY db/migrations ./db/migrations
COPY scripts/start.ts scripts/migrate.ts ./scripts/
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
# migraciones → negocios y cuentas → servidor (que sincroniza las webs solo)
CMD ["node_modules/.bin/tsx", "scripts/start.ts"]
