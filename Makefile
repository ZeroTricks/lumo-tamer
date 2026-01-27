# Lumo Bridge Makefile
# Uses multi-stage Dockerfile with targets for dev and production builds

.PHONY: help dev dev-build dev-down shell logs install clean build go-auth go-auth-build

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

# Authentication (go-proton-api)
go-auth-build: ## Build the Go authentication binary
	cd src/auth/login/go && go build -o ../../../../dist/proton-auth

go-auth: go-auth-build ## Run SRP authentication (interactive)
	./dist/proton-auth -o sessions/auth-tokens.json

# Docker development
dev-docker: ## Start development container
	docker compose up app-dev browser-dev || [ $$? -eq 130 ]

dev-build: ## Build and start development container
	docker compose up app-dev browser-dev --build || [ $$? -eq 130 ]

dev-down: ## Stop development container
	docker compose down

dev-restart: ## Restart development container
	docker compose restart app-dev browser-dev

shell: ## Open shell in development app container
	docker compose exec app-dev /bin/bash

shell-browser: ## Open shell in development browser container
	docker compose exec browser-dev /bin/bash

logs: ## Follow all container logs
	docker compose logs -f app-dev browser-dev

logs-app: ## Follow app container logs only
	docker compose logs -f app-dev

logs-browser: ## Follow browser container logs only
	docker compose logs -f browser-dev

# Production
prod-build: ## Build production container
	docker compose build app browser-dev

prod-up: ## Start production container
	docker compose up -d app browser-dev

prod-down: ## Stop production container
	docker compose down

prod-logs: ## View production logs
	docker compose logs -f app browser-dev

# Utilities
x11-enable: ## Enable X11 forwarding (Linux)
	xhost +local:docker

clean-sessions: ## Clear saved login sessions
	rm -rf sessions/*

clean-all: clean ## Clean everything including docker volumes
	docker compose down -v
