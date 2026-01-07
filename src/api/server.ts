import express, { Request, Response, NextFunction } from 'express';
import { BrowserManager } from '../browser/manager.js';
import { ChatboxInteractor } from '../browser/chatbox.js';
import { RequestQueue } from '../queue/manager.js';
import { serverConfig } from '../config.js';
import { OpenAIChatRequest, OpenAIStreamChunk, OpenAIChatResponse } from '../types.js';
import { randomUUID } from 'crypto';

export class APIServer {
  private app: express.Application;
  private browserManager: BrowserManager;
  private chatbox: ChatboxInteractor | null = null;
  private queue: RequestQueue;

  constructor(browserManager: BrowserManager) {
    this.app = express();
    this.browserManager = browserManager;
    this.queue = new RequestQueue(1); // Process one message at a time

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // API Key authentication
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      // Skip auth for health endpoint
      if (req.path === '/health') {
        return next();
      }

      const apiKey = req.headers.authorization?.replace('Bearer ', '');
      if (apiKey !== serverConfig.apiKey) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      next();
    });

    // Logging
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', queue: { size: this.queue.getSize(), pending: this.queue.getPending() } });
    });

    // OpenAI-compatible models endpoint
    this.app.get('/v1/models', (req: Request, res: Response) => {
      res.json({
        object: 'list',
        data: [
          {
            id: serverConfig.modelName,
            object: 'model',
            created: Date.now(),
            owned_by: 'lumo-bridge',
          },
        ],
      });
    });

    // OpenAI-compatible chat completions endpoint
    this.app.post('/v1/chat/completions', async (req: Request, res: Response) => {
      try {
        const request: OpenAIChatRequest = req.body;

        // Validate request
        if (!request.messages || request.messages.length === 0) {
          return res.status(400).json({ error: 'Messages array is required' });
        }

        // Get the last user message
        const lastUserMessage = [...request.messages].reverse().find(m => m.role === 'user');
        if (!lastUserMessage) {
          return res.status(400).json({ error: 'No user message found' });
        }

        const chatbox = await this.getChatbox();

        // Add to queue and process
        if (request.stream) {
          // Streaming response
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          await this.queue.add(async () => {
            const id = `chatcmpl-${randomUUID()}`;
            const created = Math.floor(Date.now() / 1000);

            try {
              // Send message
              console.log('[Server] Sending message to chatbox...');
              await chatbox.sendMessage(lastUserMessage.content);
              console.log('[Server] Message sent, starting stream...');

              // Stream response with callback for each delta
              await chatbox.streamResponse((delta) => {
                console.log('[Server] Delta callback received:', delta.length, 'chars');
                const chunk: OpenAIStreamChunk = {
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model: request.model || 'lumo',
                  choices: [
                    {
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              });
              console.log('[Server] Stream completed');

              // Send final chunk
              const finalChunk: OpenAIStreamChunk = {
                id,
                object: 'chat.completion.chunk',
                created,
                model: request.model || 'lumo',
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (error) {
              const errorChunk = {
                error: {
                  message: String(error),
                  type: 'server_error',
                },
              };
              res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
              res.end();
            }
          });
        } else {
          // Non-streaming response
          const result = await this.queue.add(async () => {
            await chatbox.sendMessage(lastUserMessage.content);
            const response = await chatbox.waitForResponse();
            return response;
          });

          const response: OpenAIChatResponse = {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: request.model || serverConfig.modelName,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: result,
                },
                finish_reason: 'stop',
              },
            ],
          };

          res.json(response);
        }
      } catch (error) {
        console.error('Error processing chat completion:', error);
        res.status(500).json({ error: String(error) });
      }
    });
  }

  private async getChatbox(): Promise<ChatboxInteractor> {
    if (!this.chatbox) {
      const page = await this.browserManager.getPage();
      this.chatbox = new ChatboxInteractor(page);
    }
    return this.chatbox;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(serverConfig.port, () => {
        console.log(`API server running on http://localhost:${serverConfig.port}`);
        console.log(`OpenAI-compatible endpoint: http://localhost:${serverConfig.port}/v1/chat/completions`);
        resolve();
      });
    });
  }
}
