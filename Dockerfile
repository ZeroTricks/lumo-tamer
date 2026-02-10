# Lightweight Dockerfile for lumo-tamer (no browser dependencies)
# If needed, connects to remote browser via CDP, instead of bundling Chrome

# ============================================================================
# Base stage - minimal Node.js dependencies only
# ============================================================================
FROM node:22-alpine AS base

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# ============================================================================
# Go builder stage - compile static Go binary
# ============================================================================
FROM golang:1.24-alpine AS go-builder

WORKDIR /build
COPY src/auth/login/go ./
# CGO_ENABLED=0 produces a static binary - runs on Alpine, Debian, or native
RUN CGO_ENABLED=0 go build -o proton-auth

# ============================================================================
# Builder stage - compile TypeScript
# ============================================================================
FROM base AS builder

# Install all dependencies (including dev dependencies for building)
RUN npm i

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# ============================================================================
# Final stage
# ============================================================================
FROM base

# Install production dependencies and clean cache
RUN npm i --only=production && npm cache clean --force

# Copy compiled TypeScript from builder
COPY --from=builder /app/dist ./dist

# Copy config defaults (required at runtime)
COPY config.defaults.yaml ./

# Copy Go binary from go-builder
COPY --from=go-builder /build/proton-auth ./dist/proton-auth

# Make tamer available as command
RUN npm link



# Command aliases for tamer subcommands auth, server, cli
#   docker compose run --rm -it tamer auth
#   docker compose run --rm -it tamer server
#   docker compose run --rm -it tamer cli
ENTRYPOINT ["sh", "-c", "\
  case \"$1\" in \
    auth)   shift; exec tamer auth \"$@\" ;; \
    server) shift; exec tamer server \"$@\" ;; \
    cli)    shift; exec tamer \"$@\" ;; \
    '')     exec tamer server ;; \
    *)      exec \"$@\" ;; \
  esac", "--"]

# Expose API port
EXPOSE 3003

CMD ["server"]
