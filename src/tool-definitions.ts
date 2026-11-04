// Tool definitions: the entire contract an agent sees before it calls anything.
//
// These descriptions are the only chance to prevent a wrong first call, so each
// one states three things in this order: what the tool returns, what must already
// be true to use it, and the specific confusion that breaks first attempts — with
// a literal example to copy. Prose alone underperforms here; worked examples are
// what models actually imitate.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const API_VALUES = ["jsfx", "reascript"] as const;
// The schema accepts one extra value the handler does not canonicalise: "reaper",
// the name virtually every first-time caller reaches for (the dataset IS REAPER's
// API; "ReaScript" is the scripting layer's name). It is declared here so the
// harness's pre-flight validation admits it, and normalised in the handler.
const API_ENUM = [...API_VALUES, "reaper"] as const;
const LANGUAGE_VALUES = ["c", "c++", "cpp", "eel", "eel2", "jsfx", "lua", "python", "py"] as const;

/**
 * Every tool answers with the same envelope, so a caller learns the shape once.
 * This function emits only the SHAPE. Field-level meaning is explained once per
 * tool in its `description` (see ENVELOPE_NOTE), never here.
 *
 * Why: `envelope()` is called once per tool at module load, and JSON Schema
 * requires each outputSchema to be self-contained, so the wire payload carries
 * five independent copies — reuse in source buys nothing on the wire. Only
 * `results.items` differs between tools, so every byte written here is charged
 * five times (a documented envelope cost 2011 B per tool; this costs 815 B).
 */
function envelope(items: Record<string, unknown>): NonNullable<Tool["outputSchema"]> {
  return {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      results: { type: "array", items },
      total: { type: "integer" },
      returned: { type: "integer" },
      limit: { type: ["integer", "null"] },
      truncated: { type: "boolean" },
      query: { type: ["object", "null"] },
      error: { type: ["string", "null"] },
      did_you_mean: { type: "array", items: { type: "string" } },
      also_found_in: { type: ["object", "null"] },
      next_step: { type: ["string", "null"] },
      retry: {
        type: ["object", "null"],
        properties: {
          tool: { type: "string" },
          arguments: { type: "object" },
        },
      },
      notes: { type: "array", items: { type: "string" } },
    },
    required: ["ok", "results", "total", "returned", "truncated"],
  };
}

const FUNCTION_ITEM = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    signatures: {
      type: "object",
      description: "Keyed by language (c, eel2, lua, python); each holds the return values and parameters for that binding.",
    },
    available_in: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const NAME_ITEM = {
  type: "object",
  properties: {
    name: { type: "string", description: "Pass this verbatim as get_function_info's function_name, with the same api value." },
    api: { type: "string" },
  },
  additionalProperties: true,
};

const ACTION_ITEM = {
  type: "object",
  properties: {
    id: { type: "string", description: "Numeric command ID. Meaningless without 'section'." },
    section: { type: "string", description: "The action section this ID belongs to." },
    name: { type: "string", description: "The action label as REAPER's Actions list shows it." },
    category: { type: ["string", "null"] },
    source: { type: "string", description: "'reaper' for stock actions, 'sws' for SWS extension actions." },
    contexts: { type: "array", items: { type: "string" }, description: "Contexts the section covers (get_action only)." },
    invoke: { type: ["string", "null"], description: "The ReaScript call that runs this section's actions (get_action only)." },
  },
  additionalProperties: true,
};

/**
 * The envelope's field meanings, stated once per tool in the `description`,
 * which each tool sends exactly once. The same text in `outputSchema` would be
 * charged five times over, because every tool ships its own copy of the schema.
 * Kept to two lines: a caller meets the optional fields in the response itself,
 * so what has to be stated up front is only how to read `ok` against `isError`
 * and that `retry` is the next call to make.
 */
const ENVELOPE_NOTE =
  "Envelope (all tools): `results` + `total`/`returned`/`truncated`; `query` = filters applied; `notes` = normalisations. Miss ⇒ `error` + `retry` (the call to make next). `ok:false` alone = nothing matched; `isError:true` = malformed call.\n\n";

export const TOOLS: Tool[] = [
  {
    name: "get_function_info",
    title: "Function reference by exact name",
    description:
      "Full signature, parameters and per-language bindings for ONE function, looked up by EXACT name.\n\n" +
      "This is a lookup, not a search — a name you have guessed or half-remembered will miss. REAPER's names are fixed and often verb-first in an unexpected order (CountTrackMediaItems, not TrackInsertMediaItemCount). If you are not certain of the spelling, call search_functions first and pass back a name it returned. A miss comes back with did_you_mean candidates and a ready-made next_step call.\n\n" +
      "api picks WHICH reference:\n" +
      "  'reascript' - REAPER's host API (~1700 functions: TrackFX_GetParam, GetMediaItem, Main_OnCommand...). Callable as reaper.X() from Lua/Python, X() from C, plain X(...) in EEL2.\n" +
      "  'jsfx' - the JSFX/Eel2 DSP built-ins usable in @sample/@slider/@gfx code (sin, sqr, abs, noise, ceil, del). These are NOT available from Lua or Python.\n" +
      "The two sets are disjoint: a name found in one is not found in the other, and the answer says so when it happens.\n\n" +
      "language only narrows which bindings of a ReaScript function are returned. It is not how you choose the reference — 'lua' is a language, not an api.\n\n" +
      ENVELOPE_NOTE + "Example: {\"api\":\"reascript\",\"function_name\":\"TrackFX_GetParam\",\"language\":\"lua\"}",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          enum: [...API_ENUM],
          description:
            "Which reference to read. 'reascript' = REAPER's host API (reaper.* from Lua/Python). 'jsfx' = JSFX/Eel2 DSP built-ins for @sample code. 'reaper' is an alias for 'reascript'. Not a language — use 'language' for that.",
        },
        function_name: {
          type: "string",
          description:
            "EXACT function name, e.g. 'TrackFX_GetParam'. Case-sensitive and not a search term — unknown names return did_you_mean rather than a fuzzy match.",
        },
        language: {
          type: "string",
          enum: [...LANGUAGE_VALUES],
          description:
            "Return only this language's binding (c, c++/cpp, eel/eel2, lua, py/python). Optional; omit to see every binding. Meaningless with api:'jsfx', which is Eel2 only.",
        },
      },
      required: ["api", "function_name"],
      examples: [
        { api: "reascript", function_name: "TrackFX_GetParam" },
        { api: "reascript", function_name: "CountTrackMediaItems", language: "lua" },
        { api: "jsfx", function_name: "sqr" },
      ],
    },
    outputSchema: envelope(FUNCTION_ITEM),
    annotations: { title: "Function reference", ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: "search_functions",
    title: "Find function names by keyword",
    description:
      "Find function names by matching keywords against names AND descriptions. Returns NAMES ONLY — no signatures. To read a signature, pass a returned name to get_function_info with the same api value.\n\n" +
      "Any keyword matching counts, so results are broad; a single broad keyword ('enum', 'count', 'track', 'marker') is usually the best first call, then narrow. Multi-word queries are OR-ed, not AND-ed.\n\n" +
      "api is required and has the same meaning as in get_function_info: 'reascript' for the host API, 'jsfx' for the JSFX/Eel2 built-ins. There is no 'lua' api — 'lua' is a language; pass language:'lua' to restrict results to functions callable from Lua.\n\n" +
      "Looking for a numbered command that a script fires (Main_OnCommand style)? Those are REAPER actions, not functions — use search_actions. A purely numeric query here will return nothing and say so.\n\n" +
      ENVELOPE_NOTE + "Example: {\"api\":\"reascript\",\"query\":\"media item count\",\"language\":\"lua\"}",
    inputSchema: {
      type: "object",
      properties: {
        api: {
          type: "string",
          enum: [...API_ENUM],
          description: "Required. 'reascript' = host API. 'jsfx' = JSFX/Eel2 built-ins. 'reaper' = alias for 'reascript'. Not a language.",
        },
        query: {
          type: "string",
          description:
            "Keywords matched against function names and their descriptions. One broad word beats several narrow ones.",
        },
        language: {
          type: "string",
          enum: [...LANGUAGE_VALUES],
          description: "Only functions available in this language. A language filter, not the reference choice — that is 'api'.",
        },
        limit: {
          type: "number",
          description: "Maximum results (default 10, max 100). Check 'truncated' in the response before assuming you saw everything.",
          default: 10,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["api", "query"],
      examples: [
        { api: "reascript", query: "enum" },
        { api: "reascript", query: "insert envelope point", language: "lua" },
        { api: "jsfx", query: "delay" },
      ],
    },
    outputSchema: envelope(NAME_ITEM),
    annotations: { title: "Search functions", ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: "search_actions",
    title: "Find REAPER actions by description",
    description:
      "Search REAPER actions: the commands a script fires with Main_OnCommand / MIDIEditor_OnCommand / CrossfadeEditor_OnCommand. Every result carries its command ID together with the section it belongs to.\n\n" +
      "IMPORTANT: command IDs are unique only WITHIN a section — the same number is a different action elsewhere (41075 is '[developer] Debug console' in Main but 'Set length for next inserted note: 1/4T' in MIDI Editor). Never use an ID without its section.\n\n" +
      "Unlike search_functions, multi-word queries are implicit AND: every keyword must match, falling back to partial matches only when nothing satisfies all of them. Quote-free natural language works ('insert new point at current position').\n\n" +
      "A vendor word anywhere in the query narrows to that source ('sws' -> SWS actions only). Excludes per-install ReaScript actions ('Script: foo.lua') and non-SWS extension actions.\n\n" +
      ENVELOPE_NOTE + "Example: {\"query\":\"insert envelope point\",\"section\":\"Main\",\"limit\":10}",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Words that must ALL appear in the action name (or a numeric command ID). e.g. 'insert envelope point', 'rename take', '40064'.",
        },
        section: {
          type: "string",
          description:
            "Limit to one action section. Accepts a section name or any of its contexts: 'Main', 'Main (alt-3)', 'MIDI Editor', 'MIDI Event List Editor', 'MIDI Inline Editor', 'Media Explorer', 'Crossfade Editor'. An unknown section is rejected with the valid list.",
        },
        category: {
          type: "string",
          description:
            "The prefix before the colon in the action name: 'Envelope', 'Track', 'Item', 'Automation'. Slash families group, so 'SWS' also covers 'SWS/BR' and 'Xenakios/SWS'.",
        },
        source: {
          type: "string",
          enum: ["reaper", "sws", "all"],
          description: "'reaper' stock only, 'sws' SWS-extension only, 'all' both (default).",
          default: "all",
        },
        limit: {
          type: "number",
          description: "Maximum results (default 15, max 200).",
          default: 15,
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["query"],
      examples: [
        { query: "insert envelope point" },
        { query: "move item to next track", "section": "Main" },
        { query: "marker", "source": "sws" },
      ],
    },
    outputSchema: envelope(ACTION_ITEM),
    annotations: { title: "Search actions", ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: "get_action",
    title: "Look up one action by command ID",
    description:
      "Look up a REAPER action by its numeric command ID. Returns the action name, category, source, the contexts its section covers, and the ReaScript call that runs it.\n\n" +
      "IDs are unique only per section. Omit 'section' and you get EVERY action sharing that ID across sections, with the ambiguity spelled out in notes and next_step — re-call with a section to pin it down. Pass 'section' whenever you know it.\n\n" +
      "Don't have an ID yet? Use search_actions to find one by description. The ID form is accepted as a number or a string.\n\n" +
      ENVELOPE_NOTE + "Example: {\"id\":\"40064\",\"section\":\"Main\"}",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Numeric command ID, e.g. '40064'. A number is accepted and treated as its string form.",
        },
        section: {
          type: "string",
          description:
            "Section or context used to disambiguate: 'Main', 'MIDI Editor', 'Media Explorer', 'Crossfade Editor', 'MIDI Event List Editor', 'MIDI Inline Editor' (or an alias such as 'Main (alt-3)'). Optional but strongly recommended.",
        },
      },
      required: ["id"],
      examples: [
        { id: "40064", section: "Main" },
        { id: "41075" },
      ],
    },
    outputSchema: envelope(ACTION_ITEM),
    annotations: { title: "Get action", ...READ_ONLY_ANNOTATIONS },
  },
  {
    name: "get_actions_overview",
    title: "Actions database scope and caveats",
    description:
      "Describe the actions dataset itself: every section with the contexts it covers, the ReaScript entry point used to run that section's actions, counts by category and source, and the caveats about per-section ID uniqueness and calling SWS actions through NamedCommandLookup.\n\n" +
      "No arguments. Useful before a wide search, and as the answer to 'why did my filter return nothing' — it lists the valid section and category values.\n\n" +
      ENVELOPE_NOTE + "Example: {}",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
      examples: [{}],
    },
    outputSchema: envelope({ type: "object", additionalProperties: true }),
    annotations: { title: "Actions overview", ...READ_ONLY_ANNOTATIONS },
  },
];

export const TOOL_NAMES: string[] = TOOLS.map((t) => t.name as string);
