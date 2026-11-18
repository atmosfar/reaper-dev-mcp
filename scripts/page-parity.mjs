// Checks that webpage/index.html's inlined engine ranks identically to the MCP
// server's own DataLoader — the page carries a copy of this logic, so the copy is
// what this verifies.
//
//   node scripts/page-parity.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { DataLoader } from "../dist/data-loader.js";

const html = fs.readFileSync("webpage/index.html", "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
// Parts 1+2 only: the engine and the search layer, nothing that touches the DOM.
const cut = script.indexOf("   Part 3 —");
assert.ok(cut > 0, "Part 3 marker not found");
const engineSrc = script.slice(0, script.lastIndexOf("/*", cut)) + `
globalThis.__page = {
  setRaw: (k, v) => { RAW[k] = v; index(k); },
  searchReaScript, searchJSFX, searchActions, getActions, getFunction,
  resolveSection, categoryMatches, rankCandidates, similarity, matchKeywords, hasWord,
};
`;

const ctx = vm.createContext({ console, Object, Array, String, Number, Math, JSON, RegExp, Set, Map, Error, Infinity });
vm.runInContext(engineSrc, ctx, { filename: "webpage-engine.js" });
const page = ctx.__page;

page.setRaw("reascript", JSON.parse(fs.readFileSync("data/reascript-api.json", "utf8")));
page.setRaw("actions", JSON.parse(fs.readFileSync("data/actions-api.json", "utf8")));
page.setRaw("jsfx", JSON.parse(fs.readFileSync("data/jsfx-api.json", "utf8")));

const loader = new DataLoader();

let pass = 0;
const fails = [];
const check = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else fails.push(`${label}\n     page: ${a.slice(0, 220)}\n     serv: ${b.slice(0, 220)}`);
};

// ---- hasWord must be exactly the server's \b regex ----
const wordQueries = ["fx", "get", "s", "42", "track", "pp", "item", "on", "x", "abc"];
const wordFields = [
  "TrackFX_GetParam", "40042", "Set Sine Wave Generator", "a_fx_b", "stop playback",
  "FX", "GetTrackInfo", "12", "Copy/Paste", "undo point", "Undo", "_SWS_MARKER",
];
for (const q of wordQueries) {
  for (const f of wordFields) {
    const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    check(`hasWord ${JSON.stringify(q)} in ${JSON.stringify(f)}`, page.hasWord(f.toLowerCase(), q), re.test(f));
  }
}

// ---- function search: identical order and length ----
const fnQueries = [
  "track fx param", "media item count", "TrackFX_GetParam", "envelope", "enum",
  "get set media item info", "marker region", "undo", "lua undo", "screenshot",
  "main oncommand", "project snapshot", "MIDI", "fx browse", "theme color",
  "GetMediaItem", "named config parm", "ion", "zoom", "console", "ReaWeb",
];
for (const q of fnQueries) {
  for (const lang of [undefined, "lua", "eel2", "python", "c"]) {
    const srv = loader.searchReaScriptFunctions(q, lang).map((f) => f.name);
    const cli = page.searchReaScript(q, lang).map((f) => f.name);
    check(`searchReaScript(${JSON.stringify(q)}, ${lang}) top15`, cli.slice(0, 15), srv.slice(0, 15));
    check(`searchReaScript(${JSON.stringify(q)}, ${lang}) count`, cli.length, srv.length);
    check(`searchReaScript(${JSON.stringify(q)}, ${lang}) full tail`, cli.slice(15, 60), srv.slice(15, 60));
  }
}

// ---- jsfx search ----
for (const q of ["sine", "delay", "slider", "sample", "gfx", "exp", "unknown"]) {
  const srv = loader.searchJSFXFunctions(q).map((f) => f.name);
  const cli = page.searchJSFX(q).map((f) => f.name);
  check(`searchJSFX(${JSON.stringify(q)}) top10`, cli.slice(0, 10), srv.slice(0, 10));
  check(`searchJSFX(${JSON.stringify(q)}) count`, cli.length, srv.length);
}

// ---- action search, with and without filters ----
const acCases = [
  ["insert envelope point", {}],
  ["41075", {}],
  ["42", {}],
  ["zoom time selection", {}],
  ["marker", { section: "MIDI Editor" }],
  ["marker", { section: "Main (alt-3)" }],
  ["sws marker", {}],
  ["xenakios", {}],
  ["track", { source: "reaper" }],
  ["track", { source: "all" }],
  ["random color", {}],
  ["SWS", { category: "SWS" }],
  ["param", { category: "Track" }],
  ["item", { category: "Item", section: "Main", source: "sws" }],
  ["quantize", { section: "MIDI Editor" }],
  ["crossfade", {}],
  ["nothing matches this at all zzz", {}],
  ["toggle record", {}],
  ["named command lookup", {}],
  ["53523", {}],
  ["media explorer", { section: "Media Explorer" }],
];
for (const [q, filters] of acCases) {
  const srv = loader.searchActions(q, filters).map((a) => `${a.id}@${a.section}`);
  const cli = page.searchActions(q, filters).map((a) => `${a.id}@${a.section}`);
  check(`searchActions(${JSON.stringify(q)}, ${JSON.stringify(filters)}) top15`, cli.slice(0, 15), srv.slice(0, 15));
  check(`searchActions(${JSON.stringify(q)}, ${JSON.stringify(filters)}) count`, cli.length, srv.length);
}

// ---- get_action / section resolution / category family ----
for (const id of ["41075", "2000", "40064", "53523", "999999"]) {
  check(`getActions(${id})`, page.getActions(id).map((a) => `${a.id}@${a.section}`), loader.getAction(id).map((a) => `${a.id}@${a.section}`));
}
for (const s of ["Main", "main", "MIDI Editor", "Main (alt-3)", "mEdIa eXpLoReR", "nope"]) {
  check(`resolveSection(${JSON.stringify(s)})`, page.resolveSection(s), loader.resolveActionSection(s));
}
for (const [cat, f] of [["SWS/BR", "SWS"], ["Xenakios/SWS", "SWS"], ["Track", "Tracks"], ["SWS", "SWS"], [null, "SWS"], ["Item/Normalize", "Item"]]) {
  check(`categoryMatches(${cat},${f})`, page.categoryMatches(cat, f), loader.categoryMatches(cat, f));
}

// ---- did_you_mean (src/suggest.ts) ----
const { rankCandidates } = await import("../dist/suggest.js");
const reascriptNames = JSON.parse(fs.readFileSync("data/reascript-api.json", "utf8")).functions.map((f) => f.name);
const misspelled = [
  "TrackFX_GetPraram", "TrackInsertMediaItemCount", "GetSetMediaItemInfo_Value",
  "MainOnCommand", "zzzz", "GetMIDIOutputName", "GetMediaItem", "enumthemecolors",
];
for (const name of misspelled) {
  check(`rankCandidates(${name})`, page.rankCandidates(name, reascriptNames), rankCandidates(name, reascriptNames));
}
const { similarity } = await import("../dist/suggest.js");
const pairs = [
  ["TrackFX-GetParam", "TrackFX_GetParam"], ["fx", "FX"], ["", "x"],
  ["GetParam", "TrackFX_GetParam"], ["insertmedia", "CountTrackMediaItems"],
  ["items", "item"], ["MAIN_ONCOMMAND", "Main_OnCommand"],
];
for (const [a, b] of pairs) check(`similarity(${a},${b})`, page.similarity(a, b), similarity(a, b));

console.log(`\n${pass} checks passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails.slice(0, 25)) console.log("  FAIL " + f);
  process.exit(1);
}
