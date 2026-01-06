import { BrowserManager } from './browser/manager.js';
import { APIServer } from './api/server.js';
import { serverConfig } from './config.js';

async function main() {
  console.log('Starting Lumo Bridge...');

  const browserManager = new BrowserManager();
  await browserManager.initialize();

  const apiServer = new APIServer(browserManager);
  await apiServer.start();

  console.log('\n========================================');
  console.log('✓ Lumo Bridge is ready!');
  console.log('========================================');
  console.log(`\nAPI Endpoint: http://localhost:${serverConfig.port}/v1/chat/completions`);
  console.log(`Health Check: http://localhost:${serverConfig.port}/health`);
  console.log('\nUse with OpenAI SDK:');
  console.log(`  base_url: http://localhost:${serverConfig.port}/v1`);
  console.log(`  api_key: ${serverConfig.apiKey}`);
  console.log('========================================\n');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await browserManager.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    await browserManager.close();
    process.exit(0);
  });
}

main().catch(console.error);
