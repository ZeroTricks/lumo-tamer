# OpenCode configuration

Add Lumo to `models.providers` in your OpenCode `opencode.json` config:

```json
{
  "provider": {
    "lumo-tamer": {
      "models": {
        "lumo": {
          "name": "Lumo"
        },
        "lumo-lite": {
          "name": "lumo-lite"
        },
        "lumo-max": {
          "name": "lumo-max"
        }
      },
      "name": "Lumo (local)",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3003/v1",
        "apiKey": "your-super-secret-key"
      }
    }
  }
}
```
