# Lumo Bridge Makefile
# Uses multi-stage Dockerfile with targets for dev and production builds

.PHONY: help dev dev-build dev-down shell logs install clean build

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

# Local development
install: ## Install dependencies locally
	npm install

dev: ## Run development server locally
	npm run dev

build: ## Build TypeScript locally
	npm run build

clean: ## Clean build artifacts
	npm run clean

# Docker development
dev-docker: ## Start development container
	docker compose -f docker-compose.dev.yml up || [ $$? -eq 130 ]

dev-build: ## Build and start development container
	docker compose -f docker-compose.dev.yml up --build || [ $$? -eq 130 ]

dev-down: ## Stop development container
	docker compose -f docker-compose.dev.yml down

dev-restart: ## Restart development container
	docker compose -f docker-compose.dev.yml restart

shell: ## Open shell in development container
	docker compose -f docker-compose.dev.yml exec lumo-bridge-dev /bin/bash

logs: ## Follow container logs
	docker compose -f docker-compose.dev.yml logs -f

# Production
prod-build: ## Build production container
	docker compose build

prod-up: ## Start production container
	docker compose up -d

prod-down: ## Stop production container
	docker compose down

prod-logs: ## View production logs
	docker compose logs -f

# Utilities
x11-enable: ## Enable X11 forwarding (Linux)
	xhost +local:docker

clean-sessions: ## Clear saved login sessions
	rm -rf sessions/*

clean-all: clean ## Clean everything including docker volumes
	docker compose -f docker-compose.dev.yml down -v
	docker compose down -v
