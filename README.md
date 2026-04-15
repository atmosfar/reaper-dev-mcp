# Reaper Dev MCP Server

This repo is forked from [Conceptual Machines](https://github.com/Conceptual-Machines/reaper-dev-mcp).

### Changes:
- Support for functions returning multiple values (eg `EnumProjectMarkers` in Lua and Python)
- Support for filtering function lookup requests by language (`c`/`cpp`/`c++`, `eel`/`eel2`, `lua`, `py`/`python`)
- Support for ranked search results based on multiple keywords
- Function scraper script now generates from your local reascripthelp.html file, which can include third party functions added by extensions
- Scraper support for per-language function naming conventions (eg RPR_FunctionName or reaper.FunctionName)

### Updating function definitions

1. Generate the latest HTML file in Reaper through the Help menu > ReaScript Documentation.
2. Scrape the function definitions from the file:
```bash
python scripts/scrape_reascript.py /path/to/html/file
```

### Running the MCP server

Setup first with 

```bash
npm install
npm run build
```

Then run it with 

```bash
npm run dev
```

Or in `mcp.json`:

```json
{
  "mcpServers": {
    "reaper-dev": {
      "command": "node",
      "args": [
        "/path/to/folder/reaper-dev-mcp/dist/index.js"
      ],
      "directTools": true
    }
  }
}
```

## Authorship

Written in large part by Qwen3.5 (various sizes) + llama.cpp + pi. Tested in pi with pi-mcp-adapter extension.

## License

MIT

