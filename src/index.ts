#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as http from "http";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { DataLoader } from "./data-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resource URIs
const RESOURCES = {
  "jsfx-fundamentals": {
    uri: "reascript://jsfx-fundamentals",
    name: "JSFX Fundamentals",
    description: "Core JSFX concepts: parameter indexing, slider visibility, @sections, memory management",
    file: path.join(__dirname, "../docs/jsfx-fundamentals.md"),
  },
  "parameter-system": {
    uri: "reascript://parameter-system",
    name: "REAPER Parameter System",
    description: "How REAPER's parameter system works: types, reading, setting, named config params",
    file: path.join(__dirname, "../docs/parameter-system.md"),
  },
  "parameter-modulation": {
    uri: "reascript://parameter-modulation",
    name: "Parameter Modulation (plink API)",
    description: "REAPER's parameter linking system: local vs global indices, creating/reading links",
    file: path.join(__dirname, "../docs/parameter-modulation.md"),
  },
  "fx-containers": {
    uri: "reascript://fx-containers",
    name: "FX Container System",
    description: "Working with container FX: pointers, GUIDs, parent/child navigation",
    file: path.join(__dirname, "../docs/fx-containers.md"),
  },
  "reawrap-api": {
    uri: "reascript://reawrap-api",
    name: "ReaWrap API Reference",
    description: "Reference documentation for ReaWrap's object-oriented API",
    file: path.join(__dirname, "../docs/reawrap-api.md"),
  },
};

class ReaperDevMCPServer {
  private server: Server;
  private dataLoader: DataLoader;

  constructor() {
    this.server = new Server(
      {
        name: "reaper-dev-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.dataLoader = new DataLoader();
    this.setupHandlers();
  }

  private setupHandlers() {
    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: Object.values(RESOURCES).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: "text/markdown",
        })),
      };
    });

    // Read a resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const resource = Object.values(RESOURCES).find((r) => r.uri === uri);

      if (!resource) {
        throw new Error(`Resource not found: ${uri}`);
      }

      if (!fs.existsSync(resource.file)) {
        throw new Error(`Resource file not found: ${resource.file}`);
      }

      const content = fs.readFileSync(resource.file, "utf-8");

      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_function_info",
            description: "Get detailed information about a specific function from JSFX, ReaScript, or ReaWrap API. For ReaScript API, optionally filter by language (c/eel2/lua/python)",
            inputSchema: {
              type: "object",
              properties: {
                api: {
                  type: "string",
                  enum: ["jsfx", "reascript", "reawrap"],
                  description: "Which API to query",
                },
                function_name: {
                  type: "string",
                  description: "Name of the function to look up",
                },
                class_name: {
                  type: "string",
                  description: "Class name (required for ReaWrap)",
                },
                language: {
                  type: "string",
                  enum: ["c", "c++", "cpp", "eel", "eel2", "jsfx", "lua", "python", "py"],
                  description: "Filter by language (optional)",
                },
              },
              required: ["api", "function_name"],
            },
          },
          {
            name: "search_functions",
            description: "Search for functions across JSFX, ReaScript, or ReaWrap APIs. For ReaScript API, optionally filter results by language (c/c++/eel2/lua/python). Use this tool to find a specific function name before calling `get_function_info`. A good strategy is to search for a single broad keyword first, eg 'Enum', 'Count', 'Track', 'Item', and then narrow the list down from there.",
            inputSchema: {
              type: "object",
              properties: {
                api: {
                  type: "string",
                  enum: ["jsfx", "reascript", "reawrap"],
                  description: "Which API to search",
                },
                query: {
                  type: "string",
                  description: "Search query (function name, description, etc.)",
                },
                limit: {
                  type: "number",
                  description: "Maximum number of results (default: 10)",
                  default: 10,
                },
                language: {
                  type: "string",
                  enum: ["c", "c++", "cpp", "eel", "eel2", "jsfx", "lua", "python", "py"],
                  description: "Filter by language (optional)",
                },
              },
              required: ["api", "query"],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "get_function_info": {
            // Normalize language helper
            const normalizeLanguage = (lang: string): string => {
              const map: Record<string, string> = {
                "c++": "c",
                "cpp": "c",
                "eel": "eel2",
                "jsfx": "eel2",
                "py": "python",
              };
              return map[lang.toLowerCase()] || lang.toLowerCase();
            };

            const { api, function_name, class_name, language } = args as {
              api: string;
              function_name: string;
              class_name?: string;
              language?: string;
            };
            
            const normalizedLang = language ? normalizeLanguage(language) : undefined;

            if (api === "jsfx") {
              const func = this.dataLoader.getJSFXFunction(function_name);
              if (!func) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `JSFX function "${function_name}" not found.`,
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(func, null, 2),
                  },
                ],
              };
            } else if (api === "reascript") {
              const func = this.dataLoader.getReaScriptFunction(function_name, normalizedLang);
              if (!func) {
                return {
                  content: [
                    {
                      type: "text",
                      text: language
                        ? `ReaScript function "${function_name}" not found for ${language} language.`
                        : `ReaScript function "${function_name}" not found.`,
                    },
                  ],
                };
              }
              
              // If language filter specified, return only that language's signature
              let responseFunc = func;
              if (normalizedLang) {
                const langToKey: Record<string, "c" | "eel2" | "lua" | "python"> = {
                  c: "c",
                  eel2: "eel2",
                  lua: "lua",
                  python: "python",
                };
                const key = langToKey[normalizedLang];
                responseFunc = {
                  ...func,
                  signatures: key ? { [key]: func.signatures[key] } : {},
                  available_in: [normalizedLang as "c" | "eel2" | "lua" | "python"],
                };
              }
              
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(responseFunc, null, 2),
                  },
                ],
              };
            } else if (api === "reawrap") {
              if (!class_name) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "class_name is required for ReaWrap API queries.",
                    },
                  ],
                };
              }
              const method = this.dataLoader.getReaWrapMethod(class_name, function_name);
              if (!method) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `ReaWrap method "${class_name}.${function_name}" not found.`,
                    },
                  ],
                };
              }
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(method, null, 2),
                  },
                ],
              };
            } else {
              throw new Error(`Unhandled API: ${api}`);
            }
          }

          case "search_functions": {
            // Normalize language helper
            const normalizeLanguage = (lang: string): string => {
              const map: Record<string, string> = {
                "c++": "c",
                "cpp": "c",
                "eel": "eel2",
                "jsfx": "eel2",
                "py": "python",
              };
              return map[lang.toLowerCase()] || lang.toLowerCase();
            };

            const { api, query, limit = 10, language } = args as {
              api: string;
              query: string;
              limit?: number;
              language?: string;
            };
            
            const normalizedLang = language ? normalizeLanguage(language) : undefined;

            // Search and return only function names (optimized for get_function_info lookup)
            let results: any[];

            if (api === "jsfx") {
              results = this.dataLoader.searchJSFXFunctions(query).slice(0, limit);
            } else if (api === "reascript") {
              results = this.dataLoader.searchReaScriptFunctions(query, normalizedLang).slice(0, limit);
            } else if (api === "reawrap") {
              results = this.dataLoader.searchReaWrapMethods(query).slice(0, limit);
            } else {
              throw new Error(`Unhandled API: ${api}`);
            }

            // Return only function names, not full details
            const nameResults = results.map((r: any) => ({
              name: r.name,
              api: api,
              class_name: api === "reawrap" ? (r as any).class : undefined,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(nameResults, null, 2),
                },
              ],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
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
