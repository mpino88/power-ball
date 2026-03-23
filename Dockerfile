# ─────────────────────────────────────────────────────────────
# Ballbot — Dockerfile Multi-Stage
# Build: docker build -t ballbot .
# ─────────────────────────────────────────────────────────────

# ── Etapa 1: Builder ──────────────────────────────────────────
FROM node:20-alpine3.21 AS builder

WORKDIR /app

# Instalar dependencias (separado del código para aprovechar cache de layers)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Instalar devDeps para compilar TypeScript
RUN npm ci --ignore-scripts

# Copiar fuente y compilar
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Etapa 2: Runner ───────────────────────────────────────────
FROM node:20-alpine3.21 AS runner

# Usuario no-root para reducir superficie de ataque
RUN addgroup -S ballbot && adduser -S ballbot -G ballbot

WORKDIR /app

# Solo dependencias de producción
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Código compilado desde el builder
COPY --from=builder /app/dist ./dist

# Directorio para datos persistentes (bot-users.json, etc.)
RUN mkdir -p /app/data && chown ballbot:ballbot /app/data

USER ballbot

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/bot.js"]
