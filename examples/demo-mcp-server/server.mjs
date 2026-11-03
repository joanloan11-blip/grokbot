import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'mayak-demo', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the text it receives. Возвращает переданный текст.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to return' },
        },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: 'Adds two numbers. Складывает два числа.',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.text ?? '') }] };
  }
  if (name === 'add') {
    const sum = Number(args.a) + Number(args.b);
    return { content: [{ type: 'text', text: String(sum) }] };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
