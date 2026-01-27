# lumo-tamer Makefile

.PHONY: help auth server cli build clean docker-build docker-auth docker-server docker-cli

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'


# Local

auth: ## Run authentication
	npm run auth

server: ## Run production server
	npm run server

cli: ## Run CLI - use: make cli ARGS="your prompt"
	npm run cli -- $(ARGS)

build: ## Build TypeScript and Go binary
	npm run build && cd src/auth/login/go && go build -o ../../../../dist/proton-auth

browser: ## Clean build artifacts
	npm run clean


# Docker

docker-build: ## Build Docker image
	docker compose build app

docker-auth: ## Run authentication (interactive)
	docker compose run --rm -it app npm run auth

docker-server: ## Run server
	docker compose up app

docker-cli: ## Run cli
	docker compose run app npm run cli