# lumo-tamer
This project creates an OpenAI-compatible API on top of Proton's conversation agent Lumo.

## Architecture
lumo-tamer consists of following parts: API, bridge, Lumo WebClient

- API:
  2 main API endpoints:
  - /v1/responses, see src/api/routes/responses
  - /v1/chat/completions, see src/api/routes/chat-completions.ts


- The bridge:
  See src/lumo-client, src/conversations. Our own code connecting the API to Proton's Lumo WebClient. It provides:
  - Things we can't reuse from The Lumo WebClient itself, ie. authentication
  - Own functionality: command parsing (user want to do something), tool parsing (Lumo calls tool/function), etc.

- Lumo's WebClient:
  Code from Proton's open source Lumo WebClient applications/lumo in monorepo https://github.com/ProtonMail/WebClients/ . A clone of the monorepo can be found in ~/proton/WebClients . Use docs/proton-webclients-analysis.md as a starting point.
  - src/proton-upstream: files pulled 1:1, see src/proton-upstream/UPSTREAM.md
  - src/proton-shims: partially reimplements (closed source) `@proton/crypto/*` using standard libraries


  ## Coding guidelines:
  - Try to reuse as much from Proton's WebClients as possible, which is tested and actively maintained. To do this:
    - Pull files in src/proton-upstream without modifications.
    - Use TS aliases and shims to make them work.
    - Update scripts/sync-upstream.sh when pulling new files.
    - Always mention sources/inspiration when you write code in src/proton-shims or src/lumo-client .
  - API: /v1/responses is the most important endpoint, always implement/test this one first.
  - Write modular code, reuse common logic between:
    - different authentication methods
    - /responses and /chat/completions endpoints
    - API and CLI calls
  - Use src/logger.ts for logging
  - Use config.ts, config.yaml and config.defaults.yaml to add configuration parameters. Don't put defaults in config.ts or other code; config.defaults.yaml is the single source of truth.
  - Ignore todos within code unless you need to rewrite code anyway, or unless specifically mentioned.

  ## Documentation guidelines:
  - Try to find extra information on relevant parts in docs/
  - After implementation, make sure relevant docs/ are up to date
  - Be concise in documentation. This project is in flux and documenation gets outdated quickly.