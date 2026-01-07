# Multi-stage Dockerfile for both dev and production
# Usage:
#   Production: docker build --target production -t lumo-bridge:prod .
#   Development: docker build --target development -t lumo-bridge:dev .

# ============================================================================
# Base stage - shared dependencies
# ============================================================================
FROM node:20-slim AS base

# Install Playwright system dependencies
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    libappindicator3-1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

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

# Install Playwright browsers to system-wide location accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p /opt/playwright && \
    npx playwright install chromium && \
    chmod -R 755 /opt/playwright

# Copy built code from builder stage
COPY --from=builder /app/dist ./dist

# Create user-data directory with proper permissions
RUN mkdir -p /app/user-data && chmod -R 777 /app/user-data

# Change ownership of app files to user 1000
RUN chown -R 1000:1000 /app

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

# Install Playwright browsers to system-wide location accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p /opt/playwright && \
    npx playwright install chromium && \
    chmod -R 755 /opt/playwright

# Copy source code (will be overridden by volume mount in docker-compose)
COPY src ./src

# Create user-data directory with proper permissions
RUN mkdir -p /app/user-data && chmod -R 777 /app/user-data

# Change ownership of app files to user 1000
RUN chown -R 1000:1000 /app

# Expose API port and debugger port
EXPOSE 3000 9229

# Use tsx watch for hot-reloading in development
CMD ["npm", "run", "dev"]
