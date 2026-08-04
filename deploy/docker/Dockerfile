# Arena release image: immutable runtime built by GitHub Actions.
# The image embeds source + node_modules (tsx runner), secrets never enter the image:
# they are injected at runtime from /etc/arena/{arena.env,health.env} by systemd.
#
# Build:   docker build -t ghcr.io/deliciousbuding/arena:<sha> .
# Run:     docker compose -f deploy/docker/arena-compose.yml up -d shadow
FROM node:24-slim AS builder

WORKDIR /build
COPY package.json package-lock.json ./
COPY packages/arena-hero-ts/package.json packages/arena-hero-ts/
COPY packages/arena-agent/package.json packages/arena-agent/
RUN npm ci --no-audit --no-fund

COPY contracts contracts
COPY packages packages
COPY scripts scripts
COPY deploy deploy
COPY docs docs
COPY README.md AGENTS.md .gitignore .gitattributes .nvmrc ./

FROM node:24-slim

# tsx binaries and lockfile must not be mutable at runtime; keep the image minimal.
WORKDIR /app

COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json /build/package-lock.json ./
COPY --from=builder /build/contracts contracts
COPY --from=builder /build/packages packages
COPY --from=builder /build/scripts scripts
COPY --from=builder /build/deploy deploy
COPY --from=builder /build/docs docs
COPY --from=builder /build/README.md /build/AGENTS.md ./

# Non-root runtime user; /var/lib/arena is mounted from the host with matching ownership.
RUN groupadd --system --gid 1001 arena && useradd --system --uid 1001 --gid 1001 --home-dir /var/lib/arena --no-create-home arena \
  && mkdir -p /var/lib/arena && chown -R arena:arena /var/lib/arena /app

USER arena:arena
ENV NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH

# Native TS entrypoint: the supervisor CLI reads ARENA_* env vars directly
# (ARENA_SERVICE_MODE=shadow|live, ARENA_CONFIGS, ARENA_LIVE_TICKS, ...).
# No bash wrapper layer: same code path as local `npm run arena:supervisor`.
ENTRYPOINT ["node", "--import", "tsx", "/app/packages/arena-agent/src/cli/run-supervisor.ts"]
