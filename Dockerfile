# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
# Needs devDependencies (typescript) to compile, so this cannot be the runtime
# image. build/ is gitignored, so it is produced here rather than copied in.
FROM node:26-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:26-slim AS runtime

ENV NODE_ENV=production
# The server binds to loopback unless told otherwise; inside a container that
# would be unreachable through a published port, so listen on all interfaces.
# Set MCP_AUTH_TOKEN (or put an authenticating proxy in front) when the port
# is reachable from anywhere you don't fully trust.
ENV MCP_HOST=0.0.0.0
# export_library writes here. Mount a volume on it to keep exports.
ENV PLEX_EXPORT_DIR=/app/exports

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

# /app is root-owned, so the unprivileged user can't create directories in it.
RUN mkdir -p /app/exports && chown 1000:1000 /app/exports

# Drop privileges — the node image ships an unprivileged `node` user (UID 1000).
USER 1000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "build/plex-mcp-server.js"]
CMD ["--transport", "http"]
