# OpenClaw configuration

Add Lumo to `models.providers` in your OpenClaw config:

```json
{
    "models": {
        "providers": {
            "lumo": {
                "baseUrl": "http://127.0.0.1:3003/v1",
                "apiKey": "...",
                "api": "openai-completions",
                "models": [
                    {
                        "id": "lumo",
                        "name": "Lumo",
                        "reasoning": false,
                        "input": [
                            "text"
                        ],
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0
                        },
                        "contextWindow": 25000,
                        "maxTokens": 8000
                    }
                ]
            }
        }
    }
}
```

More information: https://open-claw.bot/docs/concepts/model-providers/#local-proxies-lm-studio--vllm
