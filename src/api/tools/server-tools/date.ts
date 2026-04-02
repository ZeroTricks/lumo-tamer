import { serverToolPrefix, type ServerTool } from './registry.js';

export const dateServerTool: ServerTool = {
  definition: {
    type: 'function',
    function: {
      name: serverToolPrefix + 'get_date',
      description: 'Get current time and date',
    },
  },
  handler: async () => {
    return new Date().toISOString();
  },
};
