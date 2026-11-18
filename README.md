#  REAPER Scripting Definitions MCP Server

This repo is forked from [Conceptual Machines](https://github.com/Conceptual-Machines/reaper-dev-mcp).

The MCP server has two main tools, `search_functions` and `get_function_info`. These look up functions available in the ReaScript API in a JSON database (`data/reascript-api.json`). The database is generated from the official reaper `reascripthelp.html` page, either a local or remote copy. `search_functions` will return the name of a function, and then `get_function_info` will give its full definition including function arguments and return values.

There are three  tools for REAPER actions: `search_actions`, `get_action` and `get_actions_overview`. These read `data/actions-api.json`, generated from the actions list that REAPER exports as HTML.

The MCP server also provides information about JSFX scripting, pulled from the REAPER webpage.


### Changes:
- Support for functions returning multiple values (eg `EnumProjectMarkers` in Lua and Python)
- Support for filtering function lookup requests by language (`c`/`cpp`/`c++`, `eel`/`eel2`, `lua`, `py`/`python`)
- Support for ranked search results based on multiple keywords
- Function scraper script now generates from your local reascripthelp.html file, which can include third party functions added by extensions
- Scraper support for per-language function naming conventions (eg RPR_FunctionName or reaper.FunctionName)
- Adds database of REAPER actions with `search_actions`, `get_action` and `get_actions_overview` tools
- Failures are repairable: `did_you_mean`, `next_step`, and  `retry` response fields

### Updating definitions

```bash
python3 scripts/scrape_all.py 
```

### Running the MCP server

Setup first with 

```bash
npm install
npm run build
```

`mcp.json`:

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

Written in large part by Qwen (various sizes/generations). Tested in `pi`.

## License

MIT

