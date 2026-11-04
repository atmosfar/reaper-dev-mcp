#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as http from "http";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DataLoader } from "./data-loader.js";
import { TOOLS } from "./tool-definitions.js";
import { ToolService, toMcpResult } from "./tool-handlers.js";

class ReaperDevMCPServer {
  private server: Server;
  private tools: ToolService;

  constructor() {
    // Self-description for clients that surface server `instructions` in the
    // model's prompt (pi falls back to these when the client config has no
    // `description` of its own). The whole point is that the model can see a
    // correct first call *before* it ever calls describeTool, so line one is
    // the compact call signatures, not a marketing sentence. Keep it a single
    // line: pi renders only the first line, truncated at 250 chars, and other
    // clients charge whatever is here against the context of every request.
    // The E2E suite fails if the first line grows past that budget.
    this.server = new Server(
      {
        name: "reaper-dev-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          "REAPER API. search_functions({api:'jsfx'|'reascript',query,limit?}) get_function_info({api,function_name,language?}) search_actions({query,section?,source?}),get_action({id,section}),get_actions_overview. Reply {ok,results,did_you_mean,retry}",
      }
    );

    this.tools = new ToolService(new DataLoader());
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return toMcpResult(this.tools.call(name, args));
      } catch (error: any) {
        // Even an unexpected throw arrives as the standard envelope, so a caller
        // never has to parse a bare message to work out what to do next.
        return toMcpResult({
          isError: true,
          envelope: {
            ok: false,
            results: [],
            total: 0,
            returned: 0,
            truncated: false,
            limit: null,
            error: `Unexpected server error: ${error?.message ?? String(error)}`,
            next_step: "Retry the same call once; if it repeats, report this message verbatim. The failed call changed nothing.",
          },
        });
      }
    });
  }

  async run() {
    // Auto-detect transport mode based on how the process is invoked
    const isStdioMode = !process.stdin.isTTY && !process.env.FORCE_HTTP;

    if (isStdioMode) {
      // stdio transport for Claude Code CLI
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("Reaper Dev MCP server running in stdio mode");
    } else {
      // HTTP/SSE transport for Claude Desktop and Cursor
      const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

      const transport = new StreamableHTTPServerTransport();
      await this.server.connect(transport);

      const httpServer = http.createServer(async (req, res) => {
        try {
          await transport.handleRequest(req, res);
        } catch (error: any) {
          // Handle errors gracefully, especially for concurrent connection attempts
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
          }
        }
      });

      // Handle port already in use gracefully
      httpServer.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          console.error(`Port ${port} is already in use. Server may already be running.`);
          console.error(`If you want to use a different port, set PORT environment variable.`);
          // Don't exit - allow the existing server to handle requests
        } else {
          console.error("Server error:", error);
          process.exit(1);
        }
      });

      httpServer.listen(port, () => {
        console.error(`Reaper Dev MCP server running on http://localhost:${port}`);
      });
    }
  }
}

const server = new ReaperDevMCPServer();
server.run().catch(console.error);
