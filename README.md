#  ReaScript Function Definitions MCP Server

This repo is forked from [Conceptual Machines](https://github.com/Conceptual-Machines/reaper-dev-mcp).

The MCP server has two main tools, `search_functions` and `get_function_info`. These look up functions available in the ReaScript API in a JSON database (`data/reascript-api.json`). The database is generated from the official reaper `reascripthelp.html` page, either a local or remote copy. `search_functions` will return the name of a function, and then `get_function_info` will give its full definition including function arguments and return values.

There are three further tools for REAPER **actions** (the commands a script fires with `Main_OnCommand`, `MIDIEditor_OnCommand`, `CrossfadeEditor_OnCommand`): `search_actions`, `get_action` and `get_actions_overview`. These read `data/actions-api.json`, generated from the actions list that REAPER exports as HTML.

Note that an action's command ID is only unique **within its action section** — the same number refers to a different action in another section — so action results always carry the section alongside the ID.

### Changes:
- Support for functions returning multiple values (eg `EnumProjectMarkers` in Lua and Python)
- Support for filtering function lookup requests by language (`c`/`cpp`/`c++`, `eel`/`eel2`, `lua`, `py`/`python`)
- Support for ranked search results based on multiple keywords
- Function scraper script now generates from your local reascripthelp.html file, which can include third party functions added by extensions
- Scraper support for per-language function naming conventions (eg RPR_FunctionName or reaper.FunctionName)
- JSON database of REAPER actions with `search_actions`, `get_action` and `get_actions_overview` tools
- Action search filters by section, category and source, and treats multi-word queries as AND with a partial-match fallback
- Action database keeps stock REAPER and SWS actions (tagged in a `source` field) and drops per-install ReaScript actions (`Script: my_script.lua`) plus non-SWS extension actions, whose IDs are not portable between installs
- One response envelope for every tool, so a caller learns the shape once — see [How the tools answer](#how-the-tools-answer)
- Failures are repairable rather than merely reported: `did_you_mean`, a prose `next_step`, and a machine-readable `retry` carrying the exact follow-up call
- `api` and `language` are separated explicitly, and passing a language where a reference set belongs is rejected with a corrected call rather than a shrug
- Parameter names are matched case- and separator-insensitively (`functionName`, `func_name`, `max_results` are accepted), and function names resolve through separator variants (`TrackFX-GetParam` → `TrackFX_GetParam`)
- `outputSchema` on every tool (types only — see below), plus worked examples in each `inputSchema`, so a first-time caller has something to imitate

### How the tools answer

Every tool returns the same envelope, in both `content[0].text` (JSON) and `structuredContent`:

```json
{
  "ok": true,
  "results": [ … ],
  "total": 3106,
  "returned": 15,
  "limit": 15,
  "truncated": true,
  "query": { "query": "insert envelope point", "limit": 15 },
  "notes": [ … ]
}
```

On a miss, the same envelope adds the fields that make it repairable:

```json
{
  "ok": false,
  "results": [],
  "error": "'lua' must be one of 'jsfx' | 'reascript'; got 'lua'. 'lua' is a language, not an api — set api to 'reascript' and pass language:'lua'.",
  "next_step": "get_function_info {\"api\":\"reascript\",\"function_name\":\"TrackFX_GetParam\",\"language\":\"lua\"} — your parameters, with the value corrected",
  "retry": { "tool": "get_function_info", "arguments": { "api": "reascript", "function_name": "TrackFX_GetParam", "language": "lua" } }
}
```

Two distinctions the contract keeps deliberate:

- **`ok` is not `isError`.** A well-formed lookup that matches nothing is a legitimate answer (`ok: false`, MCP `isError: false`). A malformed call is a failure the caller must repair (`isError: true`). So "no results" and "you called this wrong" never arrive looking the same.
- **Nothing is guessed on the caller's behalf.** A parameter name that can only mean one thing is accepted and disclosed in `notes`. A value that is ambiguous between two references (`api: "eel"`) is explained and left alone, because inventing a `retry` would be a coin flip presented as an answer.

`query` echoes the filters that were actually applied, after normalisation — check it when results look wrong.

The `outputSchema` deliberately describes **shape only**. JSON Schema requires each tool's `outputSchema` to be self-contained, so an `envelope()` helper reused across five tools still ships five independent copies on the wire — anything written there is charged five times. Field meanings are therefore stated once per tool in its `description`, which is sent once. `scripts/e2e-mcp.mjs` fails if prose creeps back into the shared envelope fields.

### `api` and `language`

| | |
|---|---|
| `api: "reascript"` | REAPER's host API (~1700 functions: `TrackFX_GetParam`, `GetMediaItem`, `Main_OnCommand`). Callable as `reaper.X()` from Lua/Python, `X()` from C, plain `X(...)` in EEL2. |
| `api: "jsfx"` | The JSFX/Eel2 DSP built-ins for `@sample`/`@gfx` code (`sin`, `sqr`, `abs`, `del`). **Not** available from Lua or Python. |
| `api: "reaper"` | Accepted as an alias for `"reascript"` and normalised (disclosed in `notes`). It is the value virtually every first-time caller reaches for, so it is made correct rather than merely rejected. |
| `language` | Narrows which binding of a ReaScript function is returned. Not a way to choose the reference. |

The two sets are disjoint — the server says so, and points at the other one, when a name is found across the divide. Numbered commands a script runs are neither: they are actions, and `search_functions` redirects a numeric query to `search_actions`.


### Updating the actions list

1. In REAPER open the Actions list, then use its **Save list...** item to export the HTML.
2. Parse it into the database:
```bash
npm run parse:actions /path/to/ReaperActions.html
# or: python3 scripts/parse_actions.py /path/to/ReaperActions.html
```
The exporter does not escape `<`, `>` or `&` inside action names and puts no HTML entities anywhere, so the parser deliberately avoids `html.unescape` and anchors its row regex on the closing tag — a `[^<]*` pattern silently drops the rows whose names contain `<0/mid`.

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

### Testing

```bash
npm test          # unit tests over the data loader and tool handlers
npm run test:e2e  # drives the built server over real MCP stdio
```

`scripts/e2e-mcp.mjs` is the part that matters for first-use fluency: it connects as a real MCP client, validates every tool against the SDK's `ToolSchema`, and then makes the mistakes a new agent actually makes — `api: "lua"`, a half-remembered function name, a command ID sent to the function tools, an action ID with no section — asserting each one comes back with a retry that succeeds.

## Authorship

Written in large part by Qwen3.5 (various sizes) + llama.cpp + pi. Tested in pi with pi-mcp-adapter extension.

## License

MIT

