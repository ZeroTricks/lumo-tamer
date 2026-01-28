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

# Make tamer and tamer-server available as commands
RUN npm link

# Expose API port
EXPOSE 3003

# Default to server, override at runtime for auth/cli:
#   docker compose run --rm -it app tamer-auth
#   docker compose run --rm app tamer "prompt"
CMD ["tamer-server"]
