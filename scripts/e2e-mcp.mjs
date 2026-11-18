import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

const client = new Client({ name: "e2e", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
await client.connect(transport);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`   ${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` ${extra}` : ""}`);
};

// The server must be able to teach a cold model its call shapes without the
// client config carrying anything. pi shows the first line only, capped at
// 250 chars — that budget is asserted, not hoped for.
console.log("=== server self-description (instructions) ===");
const desc = client.getInstructions();
check("instructions are sent in initialize", typeof desc === "string" && desc.length > 0);
if (typeof desc === "string") {
  const firstLine = desc.split("\n")[0];
  check("first line fits pi's 250-char budget", firstLine.length <= 250, `(len=${firstLine.length})`);
  for (const name of ["search_functions", "get_function_info", "search_actions", "get_action", "get_actions_overview"]) {
    check(`first line names ${name}`, firstLine.includes(name));
  }
  check("first line states the api enum values", /'jsfx'\|'reascript'/.test(firstLine));
}

// ---------------------------------------------------------------- tools/list
console.log("=== tools/list: spec compliance ===");
const { tools } = await client.listTools();
check("5 tools", tools.length === 5, `(${tools.length})`);
for (const t of tools) {
  const parsed = ToolSchema.safeParse(t);
  check(`${t.name}: validates against MCP ToolSchema`, parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 200));
}
for (const t of tools) {
  check(`${t.name}: has outputSchema`, !!t.outputSchema);
  check(`${t.name}: has title`, !!t.title);
  check(`${t.name}: has worked example(s)`, Array.isArray(t.inputSchema?.examples) && t.inputSchema.examples.length > 0);
  check(`${t.name}: every required prop is described`, (t.inputSchema?.required ?? []).every((r) => t.inputSchema.properties[r]?.description));
  check(`${t.name}: description shows the trap`, /\bNOT\b|not a search|unique only|Not a language|not an api|This is a lookup/i.test(t.description ?? "") || t.name === "get_actions_overview");
  // The envelope guide must live in the description now that outputSchema is types-only.
  check(`${t.name}: description explains the envelope`, /Envelope \(all tools\)/.test(t.description ?? ""));
  check(`${t.name}: distinguishes ok:false from isError:true`, /ok:false[^]*isError:true/.test(t.description ?? ""));
  // Only the shared envelope is replicated five times, so only that part must
  // stay prose-free. Descriptions inside `results.items` are one copy per tool.
  const shared = Object.entries(t.outputSchema.properties).filter(([k]) => k !== "results");
  check(`${t.name}: shared envelope fields carry no prose (replicated x5)`, !JSON.stringify(Object.fromEntries(shared)).includes("description"));
}

// ------------------------------------------------------------- envelope shape
const call = async (tool, args) => {
  const r = await client.callTool({ name: tool, arguments: args });
  return { err: !!r.isError, env: r.structuredContent ?? JSON.parse(r.content[0].text), raw: r };
};

console.log("\n=== envelope consistency (every response) ===");
const probes = [
  ["get_function_info", { api: "reascript", function_name: "TrackFX_GetParam" }],
  ["get_function_info", { api: "jsfx", function_name: "nope" }],
  ["search_functions", { api: "reascript", query: "zzzznope" }],
  ["search_actions", { query: "zzzznope" }],
  ["get_action", { id: "99999999" }],
  ["get_actions_overview", {}],
];
const KEYS = ["ok", "results", "total", "returned", "truncated", "limit"];
for (const [tool, args] of probes) {
  const { env } = await call(tool, args);
  check(`${tool}: carries ${KEYS.join("/")}`, KEYS.every((k) => k in env), `(got ${Object.keys(env).length} keys)`);
  check(`${tool}: results is always an array`, Array.isArray(env.results));
}

// ------------------------------------------------- the canonical first mistakes
console.log("\n=== structured retry accompanies the prose next_step ===");
for (const [tool, args] of [
  ["get_function_info", { api: "lua", function_name: "TrackFX_GetParam" }],
  ["get_function_info", { api: "jsfx", function_name: "TrackFX_GetParam" }],
  ["get_function_info", { api: "reascript", function_name: "GetTrackMediaItemCount" }],
  ["search_functions", { api: "reascript", query: "41864" }],
  ["search_actions", { query: "envelope", section: "bogus" }],
  ["get_action", { id: "41075" }],
]) {
  const { env } = await call(tool, args);
  const ok = env.retry && env.next_step?.includes(env.retry.tool) && env.next_step.includes(JSON.stringify(env.retry.arguments));
  check(`${tool} retry matches prose`, !!ok, JSON.stringify(env.retry));
  const again = env.retry ? await call(env.retry.tool, env.retry.arguments) : { err: true };
  check(`  retry itself is well-formed`, again.err === false);
}

console.log("\n=== mistake 1: language passed where api belongs ===");
{
  const { err, env } = await call("get_function_info", { api: "lua", function_name: "TrackFX_GetParam" });
  check("isError", err);
  check("names 'lua'", /'lua'/.test(env.error ?? ""));
  check("hands back a corrected call, not just prose", /get_function_info \{/.test(env.next_step ?? ""));
  check("and the same retry as structured data", env.retry?.tool === "get_function_info" && env.retry.arguments.api === "reascript", JSON.stringify(env.retry));
  check("gives a copyable call", /get_function_info \{/.test(env.next_step ?? ""), `\n          ${env.next_step}`);
  check("explains lua is a language not an api", /is a language, not an api/.test(env.error ?? ""));
  {
    const corrected = env.retry.arguments;
    check("corrected call keeps the function they asked for", corrected.function_name === "TrackFX_GetParam" && corrected.api === "reascript" && corrected.language === "lua", JSON.stringify(corrected));
  }
  const fixed = await call(env.retry.tool, env.retry.arguments);
  check("suggested call actually succeeds", fixed.env.ok === true && fixed.env.results[0]?.name === "TrackFX_GetParam");
}

console.log("\n=== the natural api value 'reaper' works, not just 'reascript' ===");
{
  const natural = await call("get_function_info", { api: "reaper", function_name: "TrackFX_GetParam" });
  check("api:'reaper' succeeds", natural.env.ok === true, `(${natural.env.error})`);
  check("and normalises to the canonical value in query", natural.env.query?.api === "reascript");
  check("normalisation is disclosed in notes", /normalised from 'reaper' to 'reascript'/.test(JSON.stringify(natural.env.notes ?? [])));
  const s2 = await call("search_functions", { api: "reaper", query: "envelope", limit: 3 });
  check("search_functions accepts it too", s2.env.ok === true && s2.env.query?.api === "reascript");
  const foreign = await call("search_functions", { api: "imgui", query: "envelope" });
  check("foreign values still rejected with the real list", foreign.err && /'jsfx' \| 'reascript'/.test(foreign.env.error ?? ""));
}

console.log("\n=== mistake 2: half-remembered name treated as a search ===");
{
  const { err, env } = await call("get_function_info", { api: "reascript", function_name: "GetTrackMediaItemCount" });
  check("not an error (legitimate miss)", err === false);
  check("ok:false", env.ok === false);
  check("did_you_mean non-empty", env.did_you_mean?.length > 0, `(${env.did_you_mean?.slice(0, 3).join(", ")})`);
  check("CountTrackMediaItems in top 5", (env.did_you_mean ?? []).includes("CountTrackMediaItems"), `(got ${JSON.stringify(env.did_you_mean)})`);
  check("next_step points at search", /search_functions \{/.test(env.next_step ?? ""));
  const fixed = await call("get_function_info", { api: "reascript", function_name: env.did_you_mean[0] });
  check("first suggestion resolves to a real function", fixed.env.ok === true);
}

console.log("\n=== mistake 3: numeric command ID sent to the function tools ===");
{
  const { env } = await call("search_functions", { api: "reascript", query: "41864" });
  check("ok:false", env.ok === false);
  check("explains it is an action", /action/i.test(env.error ?? ""));
  check("also_found_in -> search_actions", env.also_found_in?.tool === "search_actions");
  const act = await call("get_action", { id: "41864", section: "Main" });
  check("redirect target returns the action", act.env.ok === true, `(${act.env.results[0]?.name})`);
}

console.log("\n=== mistake 4: name found in the other api ===");
{
  const { env } = await call("get_function_info", { api: "jsfx", function_name: "TrackFX_GetParam" });
  check("ok:false", env.ok === false);
  check("also_found_in.api = reascript", env.also_found_in?.api === "reascript");
  check("next_step is a working call", /get_function_info \{"api":"reascript"/.test(env.next_step ?? ""));
  const other = await call("get_function_info", { api: "reascript", function_name: "sin" });
  check("reverse direction too", other.env.also_found_in?.api === "jsfx", `(${JSON.stringify(other.env.also_found_in)})`);
}

console.log("\n=== mistake 5: function exists, but not in that language ===");
{
  const { env } = await call("get_function_info", { api: "reascript", function_name: "Main_OnCommand", language: "python" });
  const existsAny = await call("get_function_info", { api: "reascript", function_name: "Main_OnCommand" });
  if (existsAny.env.ok) {
    const avail = existsAny.env.results[0].available_in;
    if (!avail.includes("python")) {
      check("distinguishes missing binding", /no python binding/.test(env.error ?? ""), `(${env.error})`);
      check("lists real bindings", /available in/.test(env.error ?? ""));
    } else {
      console.log(`   SKIP  Main_OnCommand has a python binding in 7.80 (${avail})`);
    }
  }
}

console.log("\n=== mistake 6: missing / misspelled argument names ===");
{
  const noApi = await call("get_function_info", { function_name: "TrackFX_GetParam" });
  check("missing required api -> isError", noApi.err);
  check("error names the parameter", /Missing required parameter 'api'/.test(noApi.env.error ?? ""));
  check("error carries a full example", /\{.*\}/.test(noApi.env.error ?? ""));

  const camel = await call("get_function_info", { api: "reascript", functionName: "TrackFX_GetParam" });
  check("functionName is accepted as an alias", camel.env.ok === true, `(got ${camel.env.results[0]?.name})`);
  check("note records the alias", /read as 'function_name'/.test(JSON.stringify(camel.env.notes ?? [])), `(notes=${JSON.stringify(camel.env.notes)})`);

  for (const [key, label] of [["func_name", "snake abbreviation"], ["fname", "short form"], ["name", "generic"]]) {
    const alias = await call("get_function_info", { api: "reascript", [key]: "TrackFX_GetParam" });
    check(`${label} '${key}' accepted`, alias.env.ok === true, alias.env.ok ? "" : `(${alias.env.error?.split("\n")[0]})`);
  }
  const maxres = await call("search_functions", { api: "reascript", query: "envelope", max_results: 2 });
  check("max_results accepted as limit", maxres.env.ok === true && maxres.env.limit === 2, `(limit=${maxres.env.limit})`);
  const q2 = await call("search_actions", { search: "close", limit: 2 });
  check("'search' accepted as query", q2.env.ok === true && q2.env.query?.query === "close");
  const cid = await call("get_action", { command_id: "40064", sec: "Main" });
  check("command_id + sec accepted", cid.env.ok === true, `(${cid.env.error?.split("\n")[0]})`);
  const bogus = await call("get_function_info", { api: "reascript", totally_wrong_key: "x" });
  check("genuinely unknown key -> isError", bogus.err);
  check("  still lists accepted parameters", (bogus.env.did_you_mean ?? []).length > 0, `(${JSON.stringify(bogus.env.did_you_mean)})`);
  const noArgs = await call("get_actions_overview", { limit: 5 });
  check("overview rejects stray args", noArgs.err && /no parameters/.test(noArgs.env.error ?? ""));
}

console.log("\n=== mistake 7: case and separator variants of a real name ===");
{
  for (const name of ["trackfx_getparam", "TRACKFX_GETPARAM", "TrackFX-GetParam", "TrackFXGetParam", "track fx get param"]) {
    const { env } = await call("get_function_info", { api: "reascript", function_name: name });
    check(`'${name}' resolves`, env.ok === true, env.ok ? `(${env.results[0].name})` : `(${env.error})`);
  }
}

console.log("\n=== mistake 8: bad section / short query / source aliases ===");
{
  const sec = await call("search_actions", { query: "envelope", section: "main window" });
  check("unknown section -> isError", sec.err);
  check("lists valid sections", /Main, MIDI Editor/.test(sec.env.error ?? ""));
  check("suggests 'Main'", sec.env.did_you_mean?.includes("Main"));

  const short = await call("search_actions", { search: "5" });
  check("1-char query -> isError with reason", short.err && /at least 2 characters/.test(short.env.error ?? ""), `(${short.env.error?.split("\n")[0]})`);

  const stock = await call("search_actions", { query: "track", source: "stock", limit: 3 });
  check("source 'stock' normalises to reaper", stock.env.ok === true && stock.env.query?.source === "reaper", `(query=${JSON.stringify(stock.env.query)})`);

  const ctx = await call("search_actions", { query: "close", section: "Main (alt-3)", limit: 3 });
  check("context form resolves to a section", ctx.env.ok === true, `(section=${ctx.env.query?.section})`);
}

console.log("\n=== mistake 9: id without a section ===");
{
  const { env } = await call("get_action", { id: "41075" });
  check("every section returned", env.results.length === 2, `(${env.results.length}: ${env.results.map((r) => r.section).join("/")})`);
  check("ok:true (it did answer)", env.ok === true);
  check("ambiguity explained", /unique only within a section/.test(JSON.stringify(env.notes)));
  check("next_step pins a section", /get_action \{"id":"41075","section"/.test(env.next_step ?? ""));
  const pinned = await call("get_action", { id: 41075, section: "Main" });
  check("numeric id coerced", pinned.env.ok === true && pinned.env.results.length === 1, `(${pinned.env.results[0]?.name})`);
}

console.log("\n=== structured retry accompanies the prose next_step ===");
for (const [tool, args] of [
  ["get_function_info", { api: "lua", function_name: "TrackFX_GetParam" }],
  ["get_function_info", { api: "jsfx", function_name: "TrackFX_GetParam" }],
  ["get_function_info", { api: "reascript", function_name: "GetTrackMediaItemCount" }],
  ["search_functions", { api: "reascript", query: "41864" }],
  ["search_actions", { query: "envelope", section: "bogus" }],
  ["get_action", { id: "41075" }],
]) {
  const { env } = await call(tool, args);
  const ok = env.retry && env.next_step?.includes(env.retry.tool) && env.next_step.includes(JSON.stringify(env.retry.arguments));
  check(`${tool} retry matches prose`, !!ok, JSON.stringify(env.retry));
  const again = env.retry ? await call(env.retry.tool, env.retry.arguments) : { err: true };
  check(`  retry itself is well-formed`, again.err === false);
}

console.log("\n=== mistake 10: unknown tool name ===");
{
  const r = await client.callTool({ name: "search_envelope_points", arguments: {} });
  const env = r.structuredContent ?? JSON.parse(r.content[0].text);
  check("unknown tool -> isError", !!r.isError);
  check("lists the 5 real tools", (env.error?.match(/get_function_info|search_functions|search_actions|get_action|get_actions_overview/g) ?? []).length === 5);
}

console.log("\n=== limits, truncation and content parity ===");
{
  const big = await call("search_actions", { query: "track", limit: 5000 });
  check("limit clamped up to the max 200", big.env.limit === 200, `(limit=${big.env.limit})`);
  check("clamping is disclosed", /nearest allowed value/.test(JSON.stringify(big.env.notes ?? [])), `(notes=${JSON.stringify(big.env.notes)})`);
  check("returned <= limit", big.env.returned <= 200 && big.env.results.length === big.env.returned);
  check("total >= returned", big.env.total >= big.env.returned, `(total=${big.env.total} returned=${big.env.returned})`);
  check("truncated flagged", big.env.truncated === true);

  const neg = await call("search_functions", { api: "reascript", query: "track", limit: -5 });
  check("negative limit clamps to 1", neg.env.ok === true && neg.env.limit === 1 && neg.env.returned === 1, `(limit=${neg.env.limit})`);
  check("and says so", /nearest allowed value/.test(JSON.stringify(neg.env.notes ?? [])));

  const t = await call("search_functions", { api: "reascript", query: "enum", limit: 2 });
  check("content[0].text === structuredContent", JSON.stringify(JSON.parse(t.raw.content[0].text)) === JSON.stringify(t.raw.structuredContent));
  check("query echo shows normalised filters", t.env.query?.api === "reascript" && t.env.query?.limit === 2);
}

console.log("\n=== jsfx path still correct ===");
{
  const f = await call("get_function_info", { api: "jsfx", function_name: "sqr" });
  check("sqr found", f.env.ok === true, `(${f.env.results[0]?.description?.slice(0, 30)})`);
  const s = await call("search_functions", { api: "jsfx", query: "trig" });
  check("jsfx search works", s.env.ok === true, `(${s.env.total} hits)`);
  const typo = await call("search_functions", { api: "jsfx", query: "trignometric" });
  check("misspelling that matches nothing says so honestly", typo.env.ok === false && typo.env.total === 0);
  check("and suggests how to broaden", /search_functions \{/.test(typo.env.next_step ?? ""), `\n          ${typo.env.next_step}`);
  const langFilter = await call("search_functions", { api: "jsfx", query: "delay", language: "lua" });
  check("language on jsfx is noted, not fatal", langFilter.env.ok === true && /Eel2 only/.test(JSON.stringify(langFilter.env.notes ?? [])));
}

const alive = await client.ping();
console.log(`\nserver alive after every probe: ${!!alive}`);
console.log(`\n${fails === 0 ? "ALL CHECKS PASSED" : fails + " CHECK(S) FAILED"}`);
await client.close();
process.exit(fails === 0 ? 0 : 1);
