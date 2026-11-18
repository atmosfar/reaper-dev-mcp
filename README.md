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
- **Order carries meaning.** Results are ranked, not merely grouped: a name that *is* what you typed beats a name that starts with it, which beats a name containing every word, which beats a description that mentions them. Ties go to the closest name, then A–Z. That is what makes `count tracks` return `CountTracks` first rather than whichever `BR_` accessor's description happens to say "…to count track sends…" — `nameTier` in `data-loader.ts`, mirrored in `webpage/index.html`.

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

### Updating the function definitions

All three databases in `data/` are committed. Rebuild them when a new REAPER lands, and commit the result with the code that depends on it.

For the ReaScript API, from the repository root:

1. In REAPER: **Help ▸ ReaScript Documentation**, then save the page it opens as `reascripthelp.html` in the repository root. Save it from REAPER rather than downloading it — the copy REAPER writes out also carries the functions its extensions registered (`BR_*`, `SWS_*`, `NF_*`…), which the published page does not. A database scraped from the download answers “no such function” for those names.
2. Scrape it into the database:

```bash
python3 scripts/scrape_reascript.py                      # reads reascripthelp.html from the repo root
npm run scrape:reascript                                 # same thing, via package.json
python3 scripts/scrape_reascript.py somewhere/else.html  # explicit path
```

If `reascripthelp.html` is not there the scraper stops and offers to fetch the official page from `reaper.fm`; take that option only deliberately, for the reason above. `npm run scrape:jsfx` and `npm run parse:actions <export>` rebuild the other two — the actions source is described under [Updating the actions list](#updating-the-actions-list).

All three can be rebuilt in one run with `python3 scripts/scrape_all.py`. JSFX is always rebuilt (its source is the live docs site); for the two files only REAPER can produce, a terminal run asks for the path — paste it (a path that does not exist is re-asked for), type `download` at the ReaScript prompt for the official page, or press Enter to skip that dataset. `--reascript <file|download>` and `--actions <file>` supply them up front; without a terminal nothing prompts, an explicitly requested input that is missing fails the run (exit 1), and one that was not is skipped with instructions. A docs page that still fails after three fetch retries is fatal rather than a warning — a silently shrunken database is worse than a failed run.

#### Where a database came from

All three stamp their origin in `generated_by`, and the lookup page shows it under the entry count.

| file | `generated_by` | why it reads that way |
|---|---|---|
| `actions-api.json` | `v7.85/macOS-arm64` | REAPER writes version **and** platform into its own Actions-list export; the parser copies it verbatim |
| `reascript-api.json` | `v7.85/macOS-arm64` | version read from the same `Generated by REAPER …` stamp in `reascripthelp.html`. REAPER names no platform there, so the scraper appends the machine it ran on — for a page saved out of REAPER, that is the install's own machine |
| same file, downloaded | `v7.86/macOS-arm64 (official reaper.fm copy: no extension functions)` | what choosing **b** produces. The annotation exists because otherwise a missing `BR_*` / `SWS_*` / `NF_*` function is indistinguishable from a function that does not exist |
| `jsfx-api.json` | `reaper.fm/sdk/js docs, no REAPER version stated` | the JSFX reference is the live docs site, not something an install writes out. Those pages carry per-function notes (`REAPER 7.02+`) and no overall version, so none is invented — the newest such note means “when this function appeared”, not “which build these docs describe” |

So a dump scraped from the download says so, and a reader can tell "this function is not in the reference" apart from "this reference was built on a machine that does not have that extension".

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
npm test                       # unit tests over the data loader and tool handlers
node scripts/e2e-mcp.mjs       # full MCP conversation, every first mistake replayed
node scripts/page-parity.mjs   # the browser's copy of the logic vs the server's
node scripts/page-render.mjs   # the browser's DOM, rendered and asserted
```

All four run against the committed data files rather than fixtures, which is the point: the ranking and the browser's copy of it are asserted against the real 2,367 functions, so rebuilding a database re-validates the search instead of merely recompiling it.

### Browser lookup

`webpage/index.html` is a single-file viewer over the same three JSON databases, applying the same ranking the tools apply: the list it renders is the list `search_functions` / `search_actions` returns for the same query and filters.

There is no build step and nothing is embedded in the file; the data is read at runtime, from whichever of these two sources is available.

**From disk.** Open `webpage/index.html` in a browser and drop `data/reascript-api.json`, `data/actions-api.json` and `data/jsfx-api.json` onto it. A `file://` page is not allowed to `fetch`, so this is how the page gets its data — and because what you drop is deflated and kept in `localStorage`, it is a once per browser setup, not a once per visit one. The files are ~6.5 MB between them and the dumps compress about 15:1, so all three cost roughly 575 KB, well inside a browser's storage quota. Dropping a file again replaces the saved copy; "clear saved files" in the footer empties the origin.

**Over HTTP.** Serve the repository and the page reads `data/` itself, never consulting storage, so it always shows the newest scrape:

```bash
python3 -m http.server 8080   # from the repository root
open http://localhost:8080/webpage/
```

Three tabs — Functions (ReaScript), Actions, JSFX — with the tool parameters exposed as controls (`language`, `section`, `category`, `source`, `limit`) and every detail pane showing the exact MCP call that returns what you are looking at. Command IDs sent to the Functions tab are redirected to the Actions tab, as they are by the server.

## Authorship

Written in large part by Qwen3.5 (various sizes) + llama.cpp + pi. Tested in pi with pi-mcp-adapter extension.

## License

MIT

