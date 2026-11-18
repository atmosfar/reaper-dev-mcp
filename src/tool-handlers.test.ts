import { describe, it, expect, beforeAll } from "vitest";
import { ToolService } from "./tool-handlers.js";
import { DataLoader } from "./data-loader.js";
import { validateArgs, type ArgSpec } from "./args.js";

const service = new ToolService(new DataLoader());
const call = (tool: string, args: unknown) => service.call(tool, args);

/** The structured follow-up, which must always agree with the prose one. */
function retryOf(envelope: any): { tool: string; arguments: any } | undefined {
  return envelope.retry;
}

describe("argument validation", () => {
  const specs: ArgSpec[] = [
    { name: "api", kind: "enum", required: true, values: ["jsfx", "reascript"] },
    { name: "function_name", kind: "string", required: true, names: ["function_name", "func_name", "name"] },
    { name: "limit", kind: "integer", default: 10, min: 1, max: 100 },
  ];
  const example = { api: "reascript", function_name: "X" };

  it("accepts alternate spellings of a parameter", () => {
    for (const key of ["function_name", "functionName", "FUNC-NAME", "func_name", "name"]) {
      const out = validateArgs({ api: "reascript", [key]: "TrackFX_GetParam", limit: 3 }, specs, example);
      expect(out.ok, key).toBe(true);
      if (out.ok) expect(out.values.function_name).toBe("TrackFX_GetParam");
    }
  });

  it("never guesses a value into a different parameter", () => {
    const out = validateArgs({ api: "reascript", function_name: "A", limit: 3, mode: "fuzzy" }, specs, example);
    expect(out.ok).toBe(false);
  });

  it("clamps integers to the nearest bound and discloses it", () => {
    const high = validateArgs({ api: "reascript", function_name: "A", limit: 5000 }, specs, example);
    expect(high.ok && high.values.limit).toBe(100);
    expect(high.ok && high.notes.join(" ")).toMatch(/nearest allowed value/);

    const low = validateArgs({ api: "reascript", function_name: "A", limit: -7 }, specs, example);
    expect(low.ok && low.values.limit).toBe(1);
  });

  it("applies defaults when an optional parameter is absent", () => {
    const out = validateArgs({ api: "reascript", function_name: "A" }, specs, example);
    expect(out.ok && out.values.limit).toBe(10);
  });

  it("requires the caller to supply required parameters", () => {
    const out = validateArgs({ function_name: "A" }, specs, example);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/Missing required parameter 'api'/);
      expect(out.error).toMatch(/'jsfx' \| 'reascript'/);
      expect(out.next_step).toMatch(/\{.*\}/);
    }
  });
});

describe("envelope contract", () => {
  const samples = () => [
    call("get_function_info", { api: "reascript", function_name: "TrackFX_GetParam" }),
    call("get_function_info", { api: "reascript", function_name: "Nope" }),
    call("get_function_info", { api: "nope", function_name: "X" }),
    call("search_functions", { api: "jsfx", query: "zzzznothing" }),
    call("search_actions", { query: "zzzznothing" }),
    call("search_actions", { query: "envelope" }),
    call("get_action", { id: "99999999" }),
    call("get_actions_overview", {}),
  ];

  it("always carries the same core fields, whatever happened", () => {
    for (const result of samples()) {
      expect(Array.isArray(result.envelope.results)).toBe(true);
      expect(typeof result.envelope.ok).toBe("boolean");
      expect(typeof result.envelope.total).toBe("number");
      expect(typeof result.envelope.returned).toBe("number");
      expect(typeof result.envelope.truncated).toBe("boolean");
      expect("limit" in result.envelope).toBe(true);
    }
  });

  it("keeps returned consistent with results and total", () => {
    for (const result of samples()) {
      const { returned, results, total, truncated, limit } = result.envelope;
      expect(returned).toBe(results.length);
      expect(returned).toBeLessThanOrEqual(total);
      if (limit !== null) expect(returned).toBeLessThanOrEqual(limit);
      expect(truncated).toBe(total > returned);
    }
  });

  it("marks malformed calls as errors and honest misses as answers", () => {
    const malformed = call("get_function_info", { api: "lua", function_name: "TrackFX_GetParam" });
    expect(malformed.isError).toBe(true);
    expect(malformed.envelope.ok).toBe(false);

    const emptyButValid = call("search_actions", { query: "zzzznothing" });
    expect(emptyButValid.isError).toBe(false);
    expect(emptyButValid.envelope.ok).toBe(false);
  });

  it("keeps the structured retry and the prose next_step in agreement", () => {
    const cases = [
      call("get_function_info", { api: "lua", function_name: "TrackFX_GetParam" }),
      call("get_function_info", { api: "jsfx", function_name: "TrackFX_GetParam" }),
      call("get_function_info", { api: "reascript", function_name: "GetTrackMediaItemCount" }),
      call("search_functions", { api: "reascript", query: "41864" }),
      call("search_actions", { query: "envelope", section: "bogus" }),
      call("get_action", { id: "41075" }),
    ];
    for (const result of cases) {
      const { retry, next_step: prose } = result.envelope;
      const hint = JSON.stringify(result.envelope.error);
      expect(retry, hint).toBeTruthy();
      expect(retry!.tool, hint).toMatch(/^(get_function_info|search_functions|search_actions|get_action|get_actions_overview)$/);
      expect(prose, hint).toContain(retry!.tool);
      expect(prose, hint).toContain(JSON.stringify(retry!.arguments));
      // The retry must be a call that is at least well-formed.
      const again = service.call(retry!.tool, retry!.arguments);
      expect(again.isError, `${retry!.tool} ${JSON.stringify(retry!.arguments)} still malformed`).toBe(false);
    }
  });

  it("gives every failure a way forward", () => {
    for (const result of samples()) {
      if (result.envelope.ok) continue;
      const hasPath = Boolean(result.envelope.next_step) || Boolean(result.envelope.also_found_in);
      expect(hasPath, `${result.envelope.error}`).toBe(true);
    }
  });
});

describe("api is a reference set, not a language", () => {
  it("accepts 'reaper' as an alias for the canonical 'reascript'", () => {
    const fn = call("get_function_info", { api: "reaper", function_name: "TrackFX_GetParam" });
    expect(fn.envelope.ok).toBe(true);
    expect(fn.envelope.query?.api).toBe("reascript");
    expect(JSON.stringify(fn.envelope.notes)).toMatch(/normalised from 'reaper' to 'reascript'/);

    const search = call("search_functions", { api: "reaper", query: "envelope", limit: 3 });
    expect(search.envelope.ok).toBe(true);
    expect(search.envelope.query?.api).toBe("reascript");

    // A genuinely foreign value still fails, and still names the real ones.
    const bogus = call("search_functions", { api: "imgui", query: "envelope" });
    expect(bogus.isError).toBe(true);
    expect(bogus.envelope.error).toMatch(/'jsfx' \| 'reascript'/);
  });

  it("repairs api:'lua' into a call that works", () => {
    const bad = call("get_function_info", { api: "lua", function_name: "TrackFX_GetParam" });
    expect(bad.isError).toBe(true);
    expect(bad.envelope.error).toMatch(/'lua' is a language, not an api/);

    const fix = retryOf(bad.envelope);
    expect(fix?.tool).toBe("get_function_info");
    expect(fix?.arguments).toMatchObject({ api: "reascript", function_name: "TrackFX_GetParam", language: "lua" });

    const retry = service.call(fix!.tool, fix!.arguments);
    expect(retry.envelope.ok).toBe(true);
    expect(retry.envelope.results[0].name).toBe("TrackFX_GetParam");
    expect(retry.envelope.results[0].signatures.lua).toBeDefined();
  });

  it("maps the unambiguous language names onto a reference, and asks about the ambiguous one", () => {
    // eel2 can only mean the Eel2 built-ins, so it is resolved, not questioned.
    const eel2 = call("get_function_info", { api: "eel2", function_name: "sin" });
    expect(eel2.envelope.ok).toBe(true);
    expect(eel2.envelope.query?.api).toBe("jsfx");
    expect(JSON.stringify(eel2.envelope.notes)).toMatch(/normalised from 'eel2' to 'jsfx'/);

    // "eel" is genuinely ambiguous: ReaScript has an EEL2 binding too, so
    // guessing would be a coin flip presented as an answer.
    const eel = call("get_function_info", { api: "eel", function_name: "sin" });
    expect(eel.isError).toBe(true);
    expect(eel.envelope.error).toMatch(/JSFX\/Eel2 built-ins are api:'jsfx'/);
    expect(eel.envelope.retry).toBeUndefined();
  });

  it("routes a command id to the actions tools", () => {
    const out = call("search_functions", { api: "reascript", query: "41864" });
    expect(out.envelope.ok).toBe(false);
    expect(out.envelope.also_found_in).toMatchObject({ tool: "search_actions", query: "41864" });
    const action = call("get_action", { id: "41864", section: "Main" });
    expect(action.envelope.results[0].name).toBe("Track: Select next envelope");
  });
});

describe("function name lookup", () => {
  it("suggests real names for a plausible-sounding wrong one", () => {
    const out = call("get_function_info", { api: "reascript", function_name: "GetTrackMediaItemCount" });
    expect(out.isError).toBe(false);
    expect(out.envelope.ok).toBe(false);
    expect(out.envelope.did_you_mean).toContain("CountTrackMediaItems");
    const first = service.call("get_function_info", { api: "reascript", function_name: out.envelope.did_you_mean![0] });
    expect(first.envelope.ok).toBe(true);
  });

  it("suggests names for a typo", () => {
    const out = call("get_function_info", { api: "reascript", function_name: "TrackFX_GetPraram" });
    expect(out.envelope.did_you_mean?.[0]).toBe("TrackFX_GetParam");
  });

  it("does not invent suggestions for an unrelated query", () => {
    const out = call("get_function_info", { api: "reascript", function_name: "banana_split" });
    expect(out.envelope.ok).toBe(false);
    expect(out.envelope.did_you_mean ?? []).toHaveLength(0);
    expect(out.envelope.next_step).toMatch(/search_functions \{/);
  });

  it("resolves case and separator variants to the canonical name", () => {
    for (const variant of ["trackfx_getparam", "TRACKFX_GETPARAM", "TrackFX-GetParam", "TrackFXGetParam", "track fx get param"]) {
      const out = call("get_function_info", { api: "reascript", function_name: variant });
      expect(out.envelope.ok, variant).toBe(true);
      expect(out.envelope.results[0].name, variant).toBe("TrackFX_GetParam");
    }
  });

  it("distinguishes a missing binding from a missing function", () => {
    const missing = call("get_function_info", { api: "reascript", function_name: "TrackFX_GetParam", language: "c" });
    const all = call("get_function_info", { api: "reascript", function_name: "TrackFX_GetParam" });
    if (all.envelope.ok && !all.envelope.results[0].available_in.includes("c")) {
      expect(missing.envelope.error).toMatch(/no c binding/);
      expect(missing.envelope.error).toMatch(/available in:/);
    } else {
      expect(missing.envelope.ok).toBe(true);
    }
    const bogus = call("get_function_info", { api: "reascript", function_name: "CountTrackMediaItems", language: "fortran" });
    expect(bogus.isError).toBe(true);
  });

  it("points at the other reference when the name lives there", () => {
    const jsfxSide = call("get_function_info", { api: "jsfx", function_name: "TrackFX_GetParam" });
    expect(jsfxSide.envelope.also_found_in).toMatchObject({ api: "reascript", name: "TrackFX_GetParam" });

    const hostSide = call("get_function_info", { api: "reascript", function_name: "sin" });
    expect(hostSide.envelope.also_found_in).toMatchObject({ api: "jsfx", name: "sin" });
  });
});

describe("actions", () => {
  it("explains that an id without a section is ambiguous", () => {
    const out = call("get_action", { id: "41075" });
    expect(out.envelope.ok).toBe(true);
    expect(out.envelope.results.length).toBeGreaterThan(1);
    expect(new Set(out.envelope.results.map((a: any) => a.section)).size).toBe(out.envelope.results.length);
    expect(JSON.stringify(out.envelope.notes)).toMatch(/unique only within a section/);
    const fix = retryOf(out.envelope);
    expect(fix?.arguments.section).toBeTruthy();
    const pinned = service.call(fix!.tool, fix!.arguments);
    expect(pinned.envelope.results).toHaveLength(1);
  });

  it("rejects an unknown section but keeps the query in the retry", () => {
    const out = call("search_actions", { query: "envelope", section: "main window" });
    expect(out.isError).toBe(true);
    expect(out.envelope.error).toMatch(/Valid sections: Main, MIDI Editor/);
    expect(out.envelope.did_you_mean).toContain("Main");
    const fix = retryOf(out.envelope);
    expect(fix?.arguments.query).toBe("envelope");
  });

  it("resolves a context to its section and says so", () => {
    const out = call("search_actions", { query: "close", section: "Main (alt-3)", limit: 3 });
    expect(out.envelope.ok).toBe(true);
    expect(out.envelope.query?.section).toBe("Main");
    expect(JSON.stringify(out.envelope.notes)).toMatch(/resolved to/);
  });

  it("returns every action for a section-free search and tags each with its section", () => {
    const out = call("search_actions", { query: "insert envelope point", limit: 5 });
    expect(out.envelope.ok).toBe(true);
    for (const row of out.envelope.results) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.section).toBe("string");
    }
  });

  it("rejects a query too short to be meaningful", () => {
    const out = call("search_actions", { query: "5" });
    expect(out.isError).toBe(true);
    expect(out.envelope.error).toMatch(/at least 2 characters/);
  });

  it("normalises a source alias and reports it in query", () => {
    const out = call("search_actions", { query: "track", source: "stock", limit: 3 });
    expect(out.envelope.ok).toBe(true);
    expect(out.envelope.query?.source).toBe("reaper");
    for (const row of out.envelope.results) expect(row.source).toBe("reaper");
  });

  it("suggests categories when a category filter empties the result", () => {
    const out = call("search_actions", { query: "envelope", category: "Envolope" });
    expect(out.envelope.ok).toBe(false);
    expect(out.envelope.did_you_mean).toContain("Envelope");
    expect(out.envelope.next_step).toMatch(/drop the category filter/);
  });

  it("takes no parameters and says so when given some", () => {
    const out = call("get_actions_overview", { limit: 5 });
    expect(out.isError).toBe(true);
    expect(out.envelope.error).toMatch(/takes no parameters/);
    const ok = call("get_actions_overview", {});
    expect(ok.envelope.ok).toBe(true);
    expect(ok.envelope.results[0].sections.length).toBe(6);
  });
});

describe("search results are names the next call can use", () => {
  it("round-trips a reascript search into get_function_info", () => {
    const found = call("search_functions", { api: "reascript", query: "count track media items", limit: 3 });
    expect(found.envelope.ok).toBe(true);
    for (const row of found.envelope.results) {
      expect(row.api).toBe("reascript");
      const detail = call("get_function_info", { api: "reascript", function_name: row.name });
      expect(detail.envelope.ok, row.name).toBe(true);
    }
  });

  it("round-trips a jsfx search", () => {
    const found = call("search_functions", { api: "jsfx", query: "sine", limit: 3 });
    expect(found.envelope.ok).toBe(true);
    const detail = call("get_function_info", { api: "jsfx", function_name: found.envelope.results[0].name });
    expect(detail.envelope.ok).toBe(true);
  });

  it("flags that more matches existed than were returned", () => {
    const out = call("search_functions", { api: "reascript", query: "track", limit: 2 });
    expect(out.envelope.truncated).toBe(true);
    expect(out.envelope.total).toBeGreaterThan(2);
    expect(out.envelope.results).toHaveLength(2);
    expect(JSON.stringify(out.envelope.notes)).toMatch(/raise limit or narrow the query/);
  });

  it("mentions the language filter in the query echo", () => {
    const out = call("search_functions", { api: "reascript", query: "envelope", language: "lua", limit: 5 });
    expect(out.envelope.query?.language).toBe("lua");
    for (const row of out.envelope.results) {
      const detail = call("get_function_info", { api: "reascript", function_name: row.name });
      expect(detail.envelope.results[0].available_in).toContain("lua");
    }
  });
});

describe("a dataset that is not installed", () => {
  // The real loader with one dataset made unreadable — a deleted or half-copied
  // file, which is the only way a clone gets here. Everything else genuinely
  // works, so the retry it is handed has to be callable for real rather than
  // asserted to exist. "No function matches 'track'" would read as a wrong query.
  const real = new DataLoader();
  const bare = new ToolService(
    new Proxy(real, {
      get: (target, prop, receiver) =>
        prop === "loadReaScript" ? () => null : Reflect.get(target, prop, receiver),
    }) as DataLoader
  );

  it("names the missing file instead of reporting a miss", () => {
    const out = bare.call("search_functions", { api: "reascript", query: "track" });
    expect(out.envelope.ok).toBe(false);
    expect(out.envelope.error).toMatch(/not installed: data\/reascript-api\.json/);
    expect(out.envelope.error).toMatch(/scrape_reascript\.py/);
    expect(out.envelope.error).not.toMatch(/No reascript function matches/);
  });

  it("says so for get_function_info too, and points at what does work", () => {
    for (const out of [
      bare.call("get_function_info", { api: "reascript", function_name: "TrackFX_GetParam" }),
      bare.call("search_functions", { api: "reascript", query: "track" }),
    ]) {
      expect(out.envelope.error).toMatch(/not installed/);
      // Still a failure with a way forward, like every other one: the tools that
      // ARE installed, as a structured retry and as prose that agrees with it.
      expect(out.envelope.retry?.tool).toBe("get_actions_overview");
      expect(out.envelope.next_step).toContain("get_actions_overview");
      expect(bare.call(out.envelope.retry!.tool, out.envelope.retry!.arguments).isError).toBe(false);
    }
  });

  it("still sends a command id to the actions dataset", () => {
    const out = bare.call("search_functions", { api: "reascript", query: "41075" });
    expect(out.envelope.error).toMatch(/command ID/);
  });

  it("does not claim the dataset is installed when the list is empty", () => {
    const emptyList = { loadReaScript: () => ({ functions: [] }), loadJSFX: () => ({ functions: [] }) } as any;
    expect(new ToolService(emptyList).call("search_functions", { api: "jsfx", query: "sin" }).envelope.error).toMatch(/not installed/);
  });
});

describe("unknown tool", () => {
  it("lists the tools that do exist", () => {
    const out = call("search_envelope_points", {});
    expect(out.isError).toBe(true);
    for (const name of ["get_function_info", "search_functions", "search_actions", "get_action", "get_actions_overview"]) {
      expect(out.envelope.error).toContain(name);
    }
  });
});
