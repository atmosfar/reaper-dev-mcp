// Tool call handling.
//
// Design rule: a wrong call should cost one round trip, not five. Every
// non-successful envelope therefore carries enough to repair itself —
// `error` says what went wrong, `did_you_mean` gives real candidates, and
// `next_step` is a call whose arguments can be pasted verbatim.
//
// `isError` is reserved for malformed calls (the caller must fix its request).
// A well-formed lookup that finds nothing is a legitimate answer: ok:false with
// isError:false, so agents can distinguish "nothing matches" from "you called
// this wrong" without parsing prose.

import { DataLoader } from "./data-loader.js";
import { ArgSpec, ArgOutcome, validateArgs } from "./args.js";
import { rankCandidates, compactForm } from "./suggest.js";

export interface Envelope {
  ok: boolean;
  results: any[];
  total: number;
  returned: number;
  limit: number | null;
  truncated: boolean;
  query?: Record<string, any>;
  error?: string;
  did_you_mean?: string[];
  also_found_in?: Record<string, any>;
  next_step?: string;
  retry?: { tool: string; arguments: Record<string, any> };
  notes?: string[];
}

export interface ToolCallResult {
  isError: boolean;
  envelope: Envelope;
}

/** What a handler supplies; build() fills in the derived fields. */
interface EnvelopeInput {
  ok: boolean;
  results?: any[];
  total?: number;
  returned?: number;
  truncated?: boolean;
  limit?: number | null;
  query?: Record<string, any>;
  error?: string;
  did_you_mean?: string[];
  also_found_in?: Record<string, any>;
  next_step?: string;
  retry?: { tool: string; arguments: Record<string, any> };
  notes?: string[];
}

function build(isError: boolean, partial: EnvelopeInput): ToolCallResult {
  const envelope: Envelope = {
    ok: partial.ok,
    results: partial.results ?? [],
    total: partial.total ?? (partial.results?.length ?? 0),
    returned: partial.returned ?? (partial.results?.length ?? 0),
    limit: partial.limit ?? null,
    truncated: partial.truncated ?? false,
    ...(partial.query && Object.keys(partial.query).length ? { query: partial.query } : {}),
    ...(partial.error ? { error: partial.error } : {}),
    ...(partial.did_you_mean?.length ? { did_you_mean: partial.did_you_mean } : {}),
    ...(partial.also_found_in ? { also_found_in: partial.also_found_in } : {}),
    ...(partial.next_step ? { next_step: partial.next_step } : {}),
    ...(partial.retry ? { retry: partial.retry } : {}),
    ...(partial.notes?.length ? { notes: partial.notes } : {}),
  };
  return { isError, envelope };
}

const miss = (p: EnvelopeInput) => build(false, p);
/** Malformed call — the caller must repair it. */
const badCall = (p: EnvelopeInput) => build(true, p);
const found = (p: EnvelopeInput) => build(false, { ...p, ok: true });

const json = (obj: unknown) => JSON.stringify(obj);

/**
 * A concrete follow-up call, emitted twice: as `retry` for a harness that
 * re-calls programmatically, and inside the prose `next_step` for a reader.
 * Deriving both from one call is what keeps them from ever disagreeing.
 */
function step(tool: string, args: Record<string, any>, note?: string) {
  return {
    retry: { tool, arguments: args },
    next_step: `${tool} ${json(args)}${note ? ` — ${note}` : ""}`,
  };
}

const API_SPECS: ArgSpec[] = [
  {
    name: "api",
    kind: "enum",
    required: true,
    values: ["jsfx", "reascript"],
    names: ["api", "reference", "dataset"],
    alias: {
      reaper: "reascript",
      reaperapi: "reascript",
      reascriptapi: "reascript",
      reascript_api: "reascript",
      hostapi: "reascript",
      host: "reascript",
      jsfxapi: "jsfx",
      jsfx_api: "jsfx",
      eel2api: "jsfx",
      eel2: "jsfx",
    },
    // The headline confusion: naming a language where a reference set is wanted.
    // Saying so explicitly is what turns a wrong first call into a right second one.
    valueHint: {
      lua: {
        message: "'lua' is a language, not an api — set api to 'reascript' and pass language:'lua'.",
        patch: { api: "reascript", language: "lua" },
      },
      python: {
        message: "'python' is a language, not an api — set api to 'reascript' and pass language:'python'.",
        patch: { api: "reascript", language: "python" },
      },
      py: {
        message: "'py' is a language, not an api — set api to 'reascript' and pass language:'python'.",
        patch: { api: "reascript", language: "python" },
      },
      c: {
        message: "'c' is a language, not an api — set api to 'reascript' and pass language:'c'.",
        patch: { api: "reascript", language: "c" },
      },
      "c++": {
        message: "'c++' is a language, not an api — set api to 'reascript' and pass language:'c++'.",
        patch: { api: "reascript", language: "c++" },
      },
      cpp: {
        message: "'cpp' is a language, not an api — set api to 'reascript' and pass language:'c++'.",
        patch: { api: "reascript", language: "c++" },
      },
      // No patch for eel/eel2: they are ambiguous between the JSFX built-ins and
      // ReaScript's EEL2 binding, and guessing would be worse than explaining.
      eel: {
        message: "'eel' is a language; JSFX/Eel2 built-ins are api:'jsfx', while ReaScript EEL2 is api:'reascript' with language:'eel2'.",
      },
      eel2: {
        message: "'eel2' is a language; JSFX/Eel2 built-ins are api:'jsfx', while ReaScript EEL2 is api:'reascript' with language:'eel2'.",
      },
      action: {
        message: "Actions (numbered commands a script runs) are a separate dataset — use search_actions.",
      },
      actions: {
        message: "Actions (numbered commands a script runs) are a separate dataset — use search_actions.",
      },
      sws: { message: "SWS is a value of 'source' on search_actions, not an api here." },
    },
  },
];

const LANGUAGE_SPEC: ArgSpec = {
  name: "language",
  kind: "enum",
  values: ["c", "c++", "cpp", "eel", "eel2", "jsfx", "lua", "python", "py"],
  names: ["language", "lang"],
};

/** Alternate spellings an agent may reach for, matched case/separator-insensitively. */
const QUERY_SPEC = (minLength?: number): ArgSpec => ({
  name: "query",
  kind: "string",
  required: true,
  names: ["query", "search", "term", "keywords", "q"],
  ...(minLength ? { minLength } : {}),
});

const LIMIT_SPEC = (def: number, max: number): ArgSpec => ({
  name: "limit",
  kind: "integer",
  default: def,
  min: 1,
  max,
  names: ["limit", "max_results", "max", "count"],
});

const SECTION_SPEC: ArgSpec = {
  name: "section",
  kind: "string",
  names: ["section", "sec"],
};

const LANG_ALIASES: Record<string, string> = {
  "c++": "c", cpp: "c", cxx: "c",
  eel: "eel2", jsfx: "eel2",
  py: "python",
};

function toLang(value?: string): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return LANG_ALIASES[lower] ?? lower;
}

function isNumeric(text: string): boolean {
  return /^\d+$/.test(text.trim());
}

export class ToolService {
  private reascriptNames?: string[];
  private jsfxNames?: string[];
  private categoryNames?: string[];
  private compactMaps = new Map<string, Map<string, string>>();

  constructor(private loader: DataLoader) {}

  private names(kind: "reascript" | "jsfx"): string[] {
    const cached = kind === "reascript" ? this.reascriptNames : this.jsfxNames;
    if (cached) return cached;
    const data = kind === "reascript" ? this.loader.loadReaScript() : this.loader.loadJSFX();
    const list: string[] = (data?.functions ?? []).map((f: any) => f.name);
    if (kind === "reascript") this.reascriptNames = list;
    else this.jsfxNames = list;
    return list;
  }

  private categories(): string[] {
    if (!this.categoryNames) {
      const overview = this.loader.getActionsOverview();
      this.categoryNames = Object.keys(overview?.categories ?? {});
    }
    return this.categoryNames;
  }

  private sections(): string[] {
    return this.loader.getActionSections().map((s) => s.name);
  }

  /** "Main" | "MIDI Editor" | ... — the ones the caller could have meant. */
  private sectionHint(): string {
    return this.sections().join(", ");
  }

  /**
   * A dataset that cannot be read at all is a broken install, not an empty API —
   * and answering it with "no reascript function matches 'track'" is the same
   * sentence a genuine miss produces, which sends the caller off deciding REAPER
   * has no such function. Name the file and say how to rebuild it. Cheap to ask on
   * every call: DataLoader caches what it parses, so once a dataset is loaded this
   * is a property read, and while one is missing it is a single existsSync.
   */
  private missingDataset(api: "jsfx" | "reascript"): string | null {
    const data = api === "reascript" ? this.loader.loadReaScript() : this.loader.loadJSFX();
    if (data && Array.isArray(data.functions) && data.functions.length > 0) return null;
    return api === "reascript"
      ? "The ReaScript dataset is not installed: data/reascript-api.json is missing or unreadable. Restore it with: git checkout -- data/reascript-api.json, or rebuild it with python3 scripts/scrape_reascript.py (README ▸ Updating the function definitions). The actions and JSFX datasets are unaffected."
      : "The JSFX dataset is not installed: data/jsfx-api.json could not be read. Regenerate it with: npm run scrape:jsfx";
  }

  private failureFromArgs(
    outcome: Extract<ArgOutcome, { ok: false }>,
    tool: string
  ): ToolCallResult {
    // When the misunderstanding was a value in the right place, hand back the
    // caller's own parameters with that value repaired — not advice about it.
    const fix = outcome.suggested_args
      ? step(tool, outcome.suggested_args, "your parameters, with the value corrected")
      : { next_step: outcome.next_step };
    return badCall({
      ok: false,
      results: [],
      error: outcome.error,
      did_you_mean: outcome.did_you_mean,
      ...fix,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Canonical name for a case/separator variant, so 'trackfx-getparam',
   * 'TrackFXGetParam' and 'TRACKFX_GETPARAM' all resolve to TrackFX_GetParam.
   *
   * Safe to apply blindly: the 1683 ReaScript names collapse to 1683 distinct
   * separator-free forms, so a compact match is never ambiguous.
   */
  private resolveName(kind: "reascript" | "jsfx", input: string): string | null {
    let map = this.compactMaps.get(kind);
    if (!map) {
      map = new Map<string, string>();
      for (const name of this.names(kind)) {
        const key = compactForm(name);
        if (key && !map.has(key)) map.set(key, name);
      }
      this.compactMaps.set(kind, map);
    }
    return map.get(compactForm(input)) ?? null;
  }

  getFunctionInfo(raw: unknown): ToolCallResult {
    const specs: ArgSpec[] = [
      ...API_SPECS,
      { name: "function_name", kind: "string", required: true, names: ["function_name", "func_name", "fname", "name", "function"] },
      LANGUAGE_SPEC,
    ];
    const example = { api: "reascript", function_name: "TrackFX_GetParam" };
    const args = validateArgs(raw, specs, example);
    if (!args.ok) return this.failureFromArgs(args, "get_function_info");

    const { api, function_name, language } = args.values as {
      api: "jsfx" | "reascript";
      function_name: string;
      language?: string;
    };
    const notes = [...args.notes];
    const lang = toLang(language);

    // Resolve separator/case variants before declaring a name unknown.
    const asReaScript = this.resolveName("reascript", function_name);
    const asJsfx = this.resolveName("jsfx", function_name);
    const canonical = (api === "jsfx" ? asJsfx : asReaScript) ?? function_name;
    if (canonical !== function_name) {
      notes.push(`'${function_name}' resolved to '${canonical}'.`);
    }

    if (isNumeric(function_name)) {
      return miss({
        ok: false,
        results: [],
        error: `'${function_name}' is a number. REAPER command IDs are actions, not API functions.`,
        also_found_in: { tool: "search_actions", query: function_name },
        ...step(
          "search_actions",
          { query: function_name },
          `to find the action; get_action ${json({ id: function_name, section: "Main" })} then returns how to invoke it`
        ),
        notes,
      });
    }

    const absent = this.missingDataset(api);
    if (absent) {
      return miss({
        ok: false,
        results: [],
        error: absent,
        ...step(
          "get_actions_overview",
          {},
          "the actions dataset is installed and takes no arguments; the ReaScript one is built by the scrape named above"
        ),
        notes,
      });
    }

    if (api === "jsfx") {
      if (language) {
        notes.push("JSFX built-ins are Eel2 only, so the language filter had no effect.");
      }
      const func = this.loader.getJSFXFunction(canonical);
      if (!func) {
        const elsewhere = asReaScript ? this.loader.getReaScriptFunction(asReaScript) : null;
        if (elsewhere) {
          return miss({
            ok: false,
            results: [],
            error: `No JSFX built-in named '${function_name}'.`,
            also_found_in: { api: "reascript", name: elsewhere.name },
            ...step(
              "get_function_info",
              { api: "reascript", function_name: elsewhere.name },
              "that name is in REAPER's host API, not the JSFX built-ins"
            ),
            notes,
          });
        }
        return miss({
          ok: false,
          results: [],
          error: `No JSFX built-in named '${function_name}'.`,
          did_you_mean: rankCandidates(function_name, this.names("jsfx")),
          ...step(
            "search_functions",
            { api: "jsfx", query: function_name.split(/[^A-Za-z0-9]+/)[0].toLowerCase() },
            "searches descriptions as well as names"
          ),
          notes,
        });
      }
      return found({
        ok: true,
        results: [func],
        limit: null,
        query: { api, function_name: func.name },
        notes,
      });
    }

    // reascript
    const func = this.loader.getReaScriptFunction(canonical, lang);

    if (!func) {
      // Distinguish "no such function" from "that function has no such binding"
      // — the second is a language-filter mistake, not a naming mistake.
      const unfiltered = this.loader.getReaScriptFunction(canonical);
      if (unfiltered && lang) {
        return miss({
          ok: false,
          results: [],
          error: `'${unfiltered.name}' exists but has no ${lang} binding. It is available in: ${unfiltered.available_in.join(", ")}.`,
          ...step("get_function_info", { api: "reascript", function_name: unfiltered.name }, "to see every binding"),
          notes,
        });
      }

      const elsewhere = asJsfx ? this.loader.getJSFXFunction(asJsfx) : null;
      if (elsewhere) {
        return miss({
          ok: false,
          results: [],
          error: `No ReaScript function named '${function_name}'.`,
          also_found_in: { api: "jsfx", name: elsewhere.name },
          ...step(
            "get_function_info",
            { api: "jsfx", function_name: elsewhere.name },
            "that name is a JSFX/Eel2 built-in, not callable from Lua or Python"
          ),
          notes,
        });
      }

      return miss({
        ok: false,
        results: [],
        error: `No ReaScript function named '${function_name}'.`,
        did_you_mean: rankCandidates(function_name, this.names("reascript")),
        ...step(
          "search_functions",
          { api: "reascript", query: function_name.split(/[^A-Za-z0-9]+/).slice(0, 2).join(" ").toLowerCase() },
          "matches descriptions, so it finds the name you are reaching for"
        ),
        notes,
      });
    }

    const shaped = lang
      ? {
          ...func,
          signatures: func.signatures[lang as keyof typeof func.signatures]
            ? { [lang]: func.signatures[lang as keyof typeof func.signatures] }
            : {},
          available_in: [lang],
        }
      : func;

    if (lang) notes.push(`Only the ${lang} binding is included; omit language for every binding.`);

    return found({
      ok: true,
      results: [shaped],
      limit: null,
      query: { api, function_name: func.name, ...(lang ? { language: lang } : {}) },
      notes,
    });
  }

  searchFunctions(raw: unknown): ToolCallResult {
    const specs: ArgSpec[] = [
      ...API_SPECS,
      QUERY_SPEC(),
      LANGUAGE_SPEC,
      LIMIT_SPEC(10, 100),
    ];
    const example = { api: "reascript", query: "media item count" };
    const args = validateArgs(raw, specs, example);
    if (!args.ok) return this.failureFromArgs(args, "search_functions");

    const { api, query, language, limit = 10 } = args.values as {
      api: "jsfx" | "reascript";
      query: string;
      language?: string;
      limit?: number;
    };
    const notes = [...args.notes];
    const lang = toLang(language);

    if (api === "jsfx" && language) {
      notes.push("JSFX built-ins are Eel2 only, so the language filter had no effect.");
    }

    const absent = this.missingDataset(api);

    if (isNumeric(query)) {
      return miss({
        ok: false,
        results: [],
        total: 0,
        limit,
        error: `'${query}' looks like a REAPER command ID. Command IDs are actions and live in a different dataset from API functions.`,
        also_found_in: { tool: "search_actions", query },
        ...step("search_actions", { query }, "command ids live in the actions dataset"),
        notes,
      });
    }

    if (absent) {
      return miss({
        ok: false,
        results: [],
        total: 0,
        limit,
        query: { api, query, limit },
        error: absent,
        ...step(
          "get_actions_overview",
          {},
          "the actions dataset is installed and takes no arguments; the ReaScript one is built by the scrape named above"
        ),
        notes,
      });
    }

    const all =
      api === "jsfx"
        ? this.loader.searchJSFXFunctions(query)
        : this.loader.searchReaScriptFunctions(query, lang);

    const queryEcho: Record<string, any> = { api, query, limit };
    if (lang) queryEcho.language = lang;

    if (all.length === 0) {
      const suggestions = rankCandidates(query, this.names(api));
      const broadest = query
        .split(/\s+/)
        .sort((a, b) => b.length - a.length)
        .slice(0, 1)
        .join(" ")
        .toLowerCase();
      const broadQuery: Record<string, any> = { api, query: broadest };
      if (lang) broadQuery.language = lang;
      return miss({
        ok: false,
        results: [],
        total: 0,
        limit,
        query: queryEcho,
        error: `No ${api} function matches '${query}'.`,
        did_you_mean: suggestions,
        ...step("search_functions", broadQuery, "one broad keyword matches far more than several"),
        notes: [
          ...notes,
          "Keywords are matched against function names and their descriptions; a word that only appears in prose will not match a name.",
        ],
      });
    }

    const page = all.slice(0, limit);
    return found({
      ok: true,
      results: page.map((f: any) => ({ name: f.name, api })),
      total: all.length,
      returned: page.length,
      limit,
      truncated: all.length > limit,
      query: queryEcho,
      notes: [
        ...notes,
        `Names only. Pass one to get_function_info with api:'${api}' for its signature${all.length > limit ? `; ${all.length - limit} more matches were cut — raise limit or narrow the query` : ""}.`,
      ],
    });
  }

  searchActions(raw: unknown): ToolCallResult {
    const specs: ArgSpec[] = [
      QUERY_SPEC(2),
      SECTION_SPEC,
      { name: "category", kind: "string", names: ["category", "cat"] },
      {
        name: "source",
        kind: "enum",
        values: ["reaper", "sws", "all"],
        default: undefined,
        names: ["source", "src"],
        alias: { stock: "reaper", native: "reaper", builtin: "reaper", any: "all", both: "all" },
      },
      LIMIT_SPEC(15, 200),
    ];
    const example = { query: "insert envelope point", section: "Main" };
    const args = validateArgs(raw, specs, example);
    if (!args.ok) return this.failureFromArgs(args, "search_actions");

    const { query, section, category, source, limit = 15 } = args.values as {
      query: string;
      section?: string;
      category?: string;
      source?: string;
      limit?: number;
    };
    const notes = [...args.notes];

    let resolvedSection: string | null = null;
    if (section) {
      resolvedSection = this.loader.resolveActionSection(section);
      if (!resolvedSection) {
        return badCall({
          ok: false,
          results: [],
          error: `Unknown action section '${section}'. Valid sections: ${this.sectionHint()}. Any context listed under a section is accepted too, e.g. 'Main (alt-3)'.`,
          did_you_mean: rankCandidates(section, this.sections(), { threshold: 0.3 }),
          ...step(
            "search_actions",
            { query, section: "Main" },
            "or omit section to search every section at once"
          ),
        });
      }
      if (resolvedSection !== section) {
        notes.push(`section '${section}' resolved to '${resolvedSection}'.`);
      }
    }

    const all = this.loader.searchActions(query, {
      section: resolvedSection ?? undefined,
      category: category ?? undefined,
      source: source ?? undefined,
    });

    const queryEcho: Record<string, any> = { query, limit };
    if (resolvedSection) queryEcho.section = resolvedSection;
    if (category) queryEcho.category = category;
    if (source && source !== "all") queryEcho.source = source;

    if (all.length === 0) {
      const applied = Object.entries(queryEcho)
        .filter(([k]) => ["section", "category", "source"].includes(k))
        .map(([k, v]) => `${k}='${v}'`);

      const relax: Record<string, any> = { query };
      const keepWord = query.split(/\s+/).filter((w: string) => !["sws", "reaper", "stock", "all"].includes(w.toLowerCase()));
      const broader = keepWord.slice(0, Math.max(1, keepWord.length - 1)).join(" ") || query;

      if (isNumeric(query)) {
        return miss({
          ok: false,
          results: [],
          total: 0,
          limit,
          query: queryEcho,
          error: `No action matches the command ID '${query}'${resolvedSection ? ` in section '${resolvedSection}'` : ""}. It may belong to a per-install ReaScript or a non-SWS extension, which are excluded from this dataset.`,
          ...step("get_action", { id: query }, "to check every section at once"),
          notes,
        });
      }

      return miss({
        ok: false,
        results: [],
        total: 0,
        limit,
        query: queryEcho,
        error: `No action matches '${query}'${applied.length ? ` with ${applied.join(" + ")}` : ""}.`,
        did_you_mean: category ? rankCandidates(category, this.categories(), { threshold: 0.3 }) : undefined,
        ...(applied.length
          ? step(
              "search_actions",
              relax,
              `drop the ${applied.map((a) => a.split("=")[0]).join("/")} filter — a zero result usually means the filter was too narrow, not that the command is missing`
            )
          : step("search_actions", { query: broader }, "action names are long sentences, so fewer words match more")),
        notes: [
          ...notes,
          applied.length
            ? `Applied filters: ${applied.join(", ")}.`
            : "Every keyword must match; try removing your least certain word.",
          "get_actions_overview lists the valid section and category values.",
        ],
      });
    }

    const page = all.slice(0, limit);
    return found({
      ok: true,
      results: page.map((a) => ({
        id: a.id,
        section: a.section,
        name: a.name,
        category: a.category,
        source: a.source,
      })),
      total: all.length,
      returned: page.length,
      limit,
      truncated: all.length > limit,
      query: queryEcho,
      notes: [
        ...notes,
        `An id means different actions in different sections — keep 'section' with it. get_action ${json({ id: page[0].id, section: page[0].section })} returns the invoking ReaScript call.`,
      ],
    });
  }

  getAction(raw: unknown): ToolCallResult {
    const specs: ArgSpec[] = [
      { name: "id", kind: "string", required: true, names: ["id", "cmd_id", "command_id", "action_id"] },
      SECTION_SPEC,
    ];
    const example = { id: "40064", section: "Main" };
    const args = validateArgs(raw, specs, example);
    if (!args.ok) return this.failureFromArgs(args, "get_action");

    const { id, section } = args.values as { id: string; section?: string };
    const notes = [...args.notes];

    let resolvedSection: string | null = null;
    if (section) {
      resolvedSection = this.loader.resolveActionSection(section);
      if (!resolvedSection) {
        return badCall({
          ok: false,
          results: [],
          error: `Unknown action section '${section}'. Valid sections: ${this.sectionHint()} (contexts such as 'Main (alt-3)' are accepted too).`,
          did_you_mean: rankCandidates(section, this.sections(), { threshold: 0.3 }),
          ...step(
            "get_action",
            { id, section: "Main" },
            "or omit section to list every action sharing that id"
          ),
        });
      }
      if (resolvedSection !== section) notes.push(`section '${section}' resolved to '${resolvedSection}'.`);
    }

    const matches = this.loader.getAction(id, resolvedSection ?? undefined);
    const queryEcho: Record<string, any> = { id };
    if (resolvedSection) queryEcho.section = resolvedSection;

    if (matches.length === 0) {
      return miss({
        ok: false,
        results: [],
        total: 0,
        query: queryEcho,
        error: resolvedSection
          ? `No action with id '${id}' in section '${resolvedSection}'. Other sections may still define it, and per-install ReaScript or non-SWS extension actions are excluded from this dataset.`
          : `No action with id '${id}' in any section. Per-install ReaScript actions ('Script: foo.lua') and non-SWS extension actions are excluded from this dataset.`,
        next_step: `search_actions ${json({ query: "the words you expect in the action name" })} — ids come from a description search, not the other way round.`,
        notes,
      });
    }

    if (matches.length > 1 && !resolvedSection) {
      const bySection = matches.map((m) => m.section);
      return found({
        ok: true,
        results: matches,
        query: queryEcho,
        notes: [
          ...notes,
          `id '${id}' is ${matches.length} different actions, one per section (${bySection.join(", ")}). Command ids are unique only within a section, so this id is not usable on its own.`,
        ],
        ...step(
          "get_action",
          { id, section: matches[0].section },
          `for a single answer; this id also exists in ${matches.slice(1).map((m) => `'${m.section}'`).join(", ")}`
        ),
      });
    }

    return found({ ok: true, results: matches, query: queryEcho, notes });
  }

  getActionsOverview(raw: unknown): ToolCallResult {
    const args = validateArgs(raw, [], {});
    if (!args.ok) return this.failureFromArgs(args, "get_actions_overview");

    const overview = this.loader.getActionsOverview();
    if (!overview) {
      return miss({
        ok: false,
        results: [],
        error: "The actions dataset is not available (data/actions-api.json could not be read).",
        next_step: "Regenerate it with: npm run parse:actions <path to REAPER's exported ReaperActions.html>",
      });
    }

    return found({
      ok: true,
      results: [overview],
      notes: [...args.notes, `${overview.total_actions} actions across ${overview.sections.length} sections.`],
    });
  }

  call(tool: string, rawArgs: unknown): ToolCallResult {
    switch (tool) {
      case "get_function_info":
        return this.getFunctionInfo(rawArgs);
      case "search_functions":
        return this.searchFunctions(rawArgs);
      case "search_actions":
        return this.searchActions(rawArgs);
      case "get_action":
        return this.getAction(rawArgs);
      case "get_actions_overview":
        return this.getActionsOverview(rawArgs);
      default:
        return badCall({
          ok: false,
          results: [],
          error: `Unknown tool '${tool}'. Available: get_function_info, search_functions, search_actions, get_action, get_actions_overview.`,
          next_step: "Re-send with one of the listed tool names; call tools/list for their schemas.",
        });
    }
  }
}

/** Render an envelope as the MCP content a client displays. */
export function toMcpResult(result: ToolCallResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.envelope, null, 2) }],
    structuredContent: result.envelope,
    isError: result.isError,
  };
}
