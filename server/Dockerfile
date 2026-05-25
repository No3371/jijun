FROM node:20-alpine AS base

WORKDIR /app

# M6 fix: run as unprivileged user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy package files and install production deps
COPY package.json ./
RUN npm install --omit=dev

# Copy source code
COPY src/ ./src/

# Create data directory and give ownership to the app user
RUN mkdir -p /app/data && chown -R appuser:appgroup /app

USER appuser

# Expose default port
EXPOSE 8787

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/api/health || exit 1

CMD ["node", "src/standalone.js"]
