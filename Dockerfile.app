# Lightweight Dockerfile for the app service (no browser dependencies)
# Connects to remote browser via CDP instead of bundling Chrome
# Usage:
#   Production: docker build -f Dockerfile.app --target production -t lumo-bridge-app:prod .
#   Development: docker build -f Dockerfile.app --target development -t lumo-bridge-app:dev .

# ============================================================================
# Base stage - minimal Node.js dependencies only
# ============================================================================
FROM node:20-slim AS base

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

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
# Production stage
# ============================================================================
FROM base AS production

# Install production dependencies only
RUN npm i --only=production

# Copy built code from builder stage
COPY --from=builder /app/dist ./dist


# Expose API port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]

# ============================================================================
# Development stage
# ============================================================================
FROM base AS development

# Install additional dev tools
RUN apt-get update && apt-get install -y \
    procps \
    vim \
    && rm -rf /var/lib/apt/lists/*

# Install all dependencies (including dev dependencies)
RUN npm install

# Copy source code (will be overridden by volume mount in docker-compose)
COPY src ./src

# Expose API port and debugger port
EXPOSE 3000 9229

# Use tsx watch for hot-reloading in development
CMD ["npm", "run", "dev"]
