// Runs webpage/index.html's ENTIRE inline script — including the DOM layer —
// against a minimal fake DOM, so every render path is actually executed and
// asserted. Complements page-parity.mjs, which checks only the engine against the
// server's DataLoader.
//
//   node scripts/page-render.mjs
import fs from "node:fs";
import vm from "node:vm";
import { DataLoader } from "../dist/data-loader.js";

/* ------------------------------------------------------------ fake DOM ---- */

const registry = new Map();
let allNodes = [];

function makeStyle() {
  // mirrors CSSStyleDeclaration closely enough: plain properties plus the
  // custom-property methods the page uses for the pane split
  const s = {
    setProperty(k, v) { s[k] = String(v); },
    removeProperty(k) { delete s[k]; },
  };
  return s;
}

function makeNode(tag) {
  const node = {
    tagName: tag.toUpperCase(),
    style: makeStyle(),
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }; },
    children: [],
    attrs: {},
    classes: [],
    listeners: {},
    parent: null,
    value: "",
    placeholder: "",
    scrollTop: 0,
    isFragment: tag === "#fragment",
    _text: "",
    focus() { document.activeElement = node; },
    select() {},
    scrollIntoView() {},
    setAttribute(k, v) {
      node.attrs[k] = String(v);
      if (k === "id") registry.set(String(v), node);
    },
    getAttribute(k) { return node.attrs[k]; },
    addEventListener(type, fn) { (node.listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) {
      const e = { target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, ...event };
      for (const fn of node.listeners[type] || []) fn(e);
    },
    appendChild(child) {
      if (child.isFragment) node.children.push(...child.children);
      else node.children.push(child);
      return child;
    },
    get className() { return node.classes.join(" "); },
    set className(v) { node.classes = String(v).split(/\s+/).filter(Boolean); },
    get classList() {
      return {
        add: (c) => { if (!node.classes.includes(c)) node.classes.push(c); },
        remove: (c) => { node.classes = node.classes.filter((x) => x !== c); },
        contains: (c) => node.classes.includes(c),
        toggle: (c, force) => {
          const has = node.classes.includes(c);
          const want = force === undefined ? !has : !!force;
          if (want && !has) node.classes.push(c);
          if (!want && has) node.classes = node.classes.filter((x) => x !== c);
          return want;
        },
      };
    },
    get textContent() {
      if (node.tagName === "#text") return node._text;
      return node.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      node.children = [];
      if (String(v) !== "") node.children.push(makeText(String(v)));
    },
    descendants() {
      const out = [];
      const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
      walk(node);
      return out;
    },
  };
  allNodes.push(node);
  return node;
}

function makeText(text) {
  const node = { tagName: "#text", children: [], attrs: {}, classes: [], listeners: {}, isFragment: false, _text: text, textContent: text, descendants: () => [], children_: [] };
  return node;
}

const body = makeNode("body");
const document = {
  activeElement: null,
  listeners: {},
  createElement: (tag) => makeNode(tag),
  createTextNode: (t) => makeText(String(t)),
  createDocumentFragment: () => makeNode("#fragment"),
  addEventListener: (type, fn) => { (document.listeners[type] ||= []).push(fn); },
  querySelector: (sel) => (sel.startsWith("#") ? registry.get(sel.slice(1)) || null : null),
  querySelectorAll: (sel) => {
    // Only "#id .class" and ".class" are used by the page.
    const parts = sel.trim().split(/\s+/);
    let scope = [body];
    if (parts[0].startsWith("#")) {
      const root = registry.get(parts[0].slice(1));
      scope = root ? [root, ...root.descendants()] : [];
      parts.shift();
    }
    const cls = parts.join(" ").split(".").filter(Boolean);
    const match = (n) => cls.every((c) => (n.classes || []).includes(c));
    const out = [];
    for (const s of scope) for (const n of s.descendants ? s.descendants() : []) if (n.classes && match(n)) out.push(n);
    return out;
  },
  get body() { return body; },
};

const location = { hash: "", protocol: "http:" };
const window = {
  listeners: {},
  confirm: () => true,
  addEventListener(type, fn) { (window.listeners[type] ||= []).push(fn); },
  dispatch(type, event = {}) { for (const fn of window.listeners[type] || []) fn({ preventDefault() {}, ...event }); },
};
const history = { replaceState: (_a, _b, url) => { location.hash = url; } };
const navigator = { clipboard: { writeText: async () => {} } };
// localStorage with a settable quota, so the QuotaExceededError path is testable.
const lsStore = new Map();
let lsQuota = Infinity;
let lsEnabled = true;
const localStorage = {
  setItem(k, v) {
    if (!lsEnabled) throw new Error("SecurityError: storage disabled");
    const size = [...lsStore].reduce((n, [key, val]) => n + key.length + val.length, 0) + String(k).length + String(v).length;
    if (size > lsQuota) {
      const err = new Error("quota");
      err.name = "QuotaExceededError";
      throw err;
    }
    lsStore.set(String(k), String(v));
  },
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => {
    lsStore.delete(String(k));
  },
  clear: () => lsStore.clear(),
};

const fetched = [];
let fetchOK = true; // false simulates a file:// page, where every fetch rejects
const fetchStub = async (url) => {
  fetched.push(url);
  if (!fetchOK) throw new TypeError("Failed to fetch");
  const file = "data/" + url.split("/").pop();
  try {
    const text = fs.readFileSync(file, "utf8");
    return { ok: true, statusText: "OK", json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404, statusText: "not found", json: async () => null };
  }
};

/* --------------------------------------------------------- load the page -- */

const html = fs.readFileSync("webpage/index.html", "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

// The static markup the page expects to find, pre-registered by id.
for (const id of ["app", "tabs", "q", "filters", "echo", "list", "detail", "about", "aboutbtn", "storagebtn", "main", "gutter", "widthbtn"]) {
  const node = makeNode("div");
  node.setAttribute("id", id);
  body.appendChild(node);
}

const EXPORT = `
globalThis.__app = { state, boot, runSearch, render, renderList, renderDetail, setQuery, select,
  switchTab, move, currentRows, aboutView, RAW, IDX, ORIGIN, ensureDataset, loadFiles, savedMap,
  storageAvailable, resolveSection, LS_NS, recentList, forgetQueries };
`;
const BASE_GLOBALS = {
  document, location, window, history, navigator, console, setTimeout, clearTimeout, setInterval, clearInterval,
  URLSearchParams, Promise, Object, Array, String, Number, Math, JSON, RegExp, Set, Map,
  Error, TypeError, Infinity, NaN, Boolean, Date, Symbol, Uint8Array, ReadableStream, TextEncoder, TextDecoder,
  CompressionStream, DecompressionStream, btoa, atob,
};
const context = vm.createContext({ ...BASE_GLOBALS, localStorage, fetch: fetchStub, globalThis: null });
delete context.globalThis;
vm.runInContext(script + EXPORT, context, { filename: "webpage-script.js" });
const app = context.__app;

// A second, throwaway instance: the page's module scope caches whether storage
// works, so a browser that forbids it has to be modelled from scratch.
function evalFreshInstance({ storage, fetchImpl, protocol = "file:" }) {
  const freshLocation = { hash: "", protocol };
  const freshDoc = { addEventListener() {}, activeElement: null, createElement: () => makeNode("div"), createTextNode: (t) => makeText(t), createDocumentFragment: () => makeNode("#fragment"), querySelector: () => null, querySelectorAll: () => [] };
  const ctx = vm.createContext({ ...BASE_GLOBALS, document: freshDoc, location: freshLocation, localStorage: storage, fetch: fetchImpl, globalThis: null });
  delete ctx.globalThis;
  vm.runInContext(script + EXPORT, ctx, { filename: "webpage-instance2.js" });
  return ctx.__app;
}

/* ------------------------------------------------------------- assertions - */

const results = [];
const check = (label, ok, detail = "") => results.push({ label, ok: !!ok, detail });
const listText = () => registry.get("list").textContent;
const detailText = () => registry.get("detail").textContent;
const echoText = () => registry.get("echo").textContent;
const rowTitles = () =>
  document.querySelectorAll("#list .row").map((r) => {
    const name = r.descendants().find((n) => n.classes && n.classes.includes("name"));
    return name ? name.textContent : "";
  });
const q = () => registry.get("q");

// switchTab() loads its dataset asynchronously; wait for it before asserting.
async function settle(key, ms = 6000) {
  const t0 = Date.now();
  while (!app.RAW[key] && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 40));
  if (!app.RAW[key]) throw new Error(`dataset ${key} never loaded: ${app.state.loadError}`);
}

const loader = new DataLoader();
/** The server's own ranking for the current tab, as the page should render it. */
const serverFn = (q, lang) => loader.searchReaScriptFunctions(q, lang).slice(0, 10).map((f) => f.name);
const serverJx = (q) => loader.searchJSFXFunctions(q).slice(0, 10).map((f) => f.name);
const serverAc = (q, filters) => loader.searchActions(q, filters).slice(0, 10).map((a) => a.name);

function reset(hash) {
  location.hash = hash || "";
  for (const n of allNodes) n.children = [];
  q().value = "";
  app.state.q = "";
  app.state.sel = null;
  app.state.lang = "";
  app.state.section = "";
  app.state.category = "";
  app.state.source = "";
  app.state.limit = "50";
  app.state.view = null;
  app.state.shown = 100;
}

await (async () => {
  reset("#tab=fn&q=track%20fx%20param");
  for (const fn of document.listeners.DOMContentLoaded || []) await fn();
  await new Promise((r) => setTimeout(r, 50));

  check("boot: fetched the reascript dataset", fetched.some((u) => u.includes("reascript-api.json")), fetched.join(" "));
  check("boot: rows rendered", rowTitles().length > 0, `rows=${rowTitles().length}`);
  check("boot: rendered order == server order", JSON.stringify(rowTitles().slice(0, 10)) === JSON.stringify(serverFn("track fx param")),
    `page ${rowTitles().slice(0, 3)} server ${serverFn("track fx param").slice(0, 3)}`);
  check("echo: counts only, no query echo", /[\d,]+ matches/.test(echoText()) && !/api=|query=|limit=/.test(echoText()), echoText());
  check("tabs: all three built", registry.get("tabs").children.length === 3);
  check("tabs: counts shown", /2,\d{3}|^\d+$/.test(registry.get("tabs").textContent), registry.get("tabs").textContent);

  // numeric query on the functions tab is redirected, like search_functions
  app.setQuery("41075");
  check("fn numeric: redirect text", listText().includes("looks like a REAPER command ID"), listText().slice(0, 120));
  check("fn numeric: no rows", rowTitles().length === 0);

  // actions tab
  app.switchTab("ac");
  await settle("actions");
  app.setQuery("insert envelope point");
  check("ac: rows rendered", rowTitles().length > 0, `rows=${rowTitles().length}`);
  check("ac: rendered order == server order", JSON.stringify(rowTitles().slice(0, 10)) === JSON.stringify(serverAc("insert envelope point")),
    `page ${rowTitles().slice(0, 3)} server ${serverAc("insert envelope point").slice(0, 3)}`);
  check("ac: rows carry id + section", registry.get("list").children[0]?.textContent.includes("Main"));

  // AND semantics, including the server's documented fallback: when no action
  // matches every keyword, partial matches come back instead of nothing.
  const mixed = "insert envelope point zzzqqq";
  app.setQuery(mixed);
  check("ac: partial fallback matches the server", JSON.stringify(rowTitles().slice(0, 10)) === JSON.stringify(serverAc(mixed)),
    `page ${rowTitles().slice(0, 2)} server ${serverAc(mixed).slice(0, 2)}`);
  check("ac: fallback is not the full-match set", rowTitles().length !== serverAc("insert envelope point").length, `${rowTitles().length} vs full-match`);
  app.setQuery("zzzqqq");
  check("ac: nothing matches -> no rows", rowTitles().length === 0, rowTitles()[0]);
  check("ac: zero-result note explains AND", /Every keyword must match/.test(listText()), listText().slice(0, 140));

  // section context resolution
  app.setQuery("marker");
  app.state.section = "Main (alt-3)";
  app.runSearch();
  app.render();
  check("ac section: resolution still stated", /resolved to 'Main'/.test(echoText()), echoText());

  // unknown section is an error naming the valid ones
  app.state.section = "Midi Editrr";
  app.runSearch();
  app.render();
  check("ac section: unknown value errors", listText().includes("Unknown action section"), listText().slice(0, 120));
  check("ac section: suggests near names", listText().includes("MIDI Editor"), listText().slice(0, 200));
  app.state.section = "";
  app.runSearch();
  app.render();

  // source extraction from query words
  app.setQuery("sws marker");
  const allSws = registry.get("list").children.slice(0, 20).every((c) => c.textContent.includes("sws") || c.textContent.includes("SWS"));
  check("ac source: 'sws' in query narrows to sws", allSws && rowTitles().length > 0);

  // function detail
  app.switchTab("fn");
  await new Promise((r) => setTimeout(r, 80));
  app.setQuery("envelope");
  app.select("fn:TrackFX_GetParam");
  check("detail: name", detailText().includes("TrackFX_GetParam"));
  check("detail: param types", detailText().includes("MediaTrack*"), detailText().slice(0, 160));
  check("detail: signature per binding", ["eel2", "lua", "python"].every((l) => detailText().includes(l)), detailText().slice(0, 200));
  check("detail: no MCP call boilerplate", !/get_function_info\(|get_action\(|search_actions\(/.test(detailText()), detailText().slice(-160));
  check("detail: description before signature", detailText().indexOf("description") < detailText().indexOf("signature"), detailText().slice(0, 120));
  check("detail: copy affordance per binding", (detailText().match(/⧉/g) || []).length >= 4, `${(detailText().match(/⧉/g) || []).length} copy buttons`);
  check("detail: no copy name link", !detailText().includes("copy name"));

  // language filter shapes the detail like the server shapes a response
  app.state.lang = "lua";
  app.runSearch();
  app.render();
  check("detail lang: lua-only note", detailText().includes("Only the lua binding"), detailText().slice(0, 120));
  check("detail lang: one binding only", (detailText().match(/⧉/g) || []).length === 1, detailText().slice(0, 80));
  app.state.lang = "";
  app.render();

  // action detail: invoke template + shared-id warning
  app.switchTab("ac");
  await settle("actions");
  app.setQuery("zoom");
  app.select("41075@Main");
  check("detail action: invoke line", detailText().includes("reaper.Main_OnCommand(41075, 0)"), detailText().slice(-260));
  check("detail action: copy affordance on the invoke line", detailText().includes("⧉"));
  app.select("2000@Main");
  check("detail action: shared-id warning", /different actions, one per section/.test(detailText()), detailText().slice(0, 200));

  // did you mean on a typo
  app.switchTab("fn");
  await new Promise((r) => setTimeout(r, 80));
  app.setQuery("TrackFX_GetPraram");
  check("miss: no rows", rowTitles().length === 0);
  check("miss: did-you-mean suggests real name", listText().includes("TrackFX_GetParam"), listText().slice(0, 200));
  check("miss: prose-vs-name caveat", listText().includes("will not match a name"), listText().slice(-200));

  // jsfx tab
  app.switchTab("jx");
  await settle("jsfx");
  app.setQuery("sine");
  check("jsfx: rendered order == server order", JSON.stringify(rowTitles().slice(0, 8)) === JSON.stringify(serverJx("sine").slice(0, 8)),
    `page ${rowTitles().slice(0, 3)} server ${serverJx("sine").slice(0, 3)}`);
  check("jsfx: dataset fetched", fetched.some((u) => u.includes("jsfx-api.json")), fetched.join(" "));

  // about view
  registry.get("aboutbtn").dispatch("click");
  check("about: caveats rendered", detailText().includes("unique only within a section"), detailText().slice(0, 120));
  check("about: sections table", detailText().includes("MIDI Editor") && detailText().includes("Crossfade Editor"));
  registry.get("aboutbtn").dispatch("click");

  // limit and pagination
  app.switchTab("ac");
  await settle("actions");
  app.state.limit = "10";
  app.setQuery("track");
  check("limit: caps rows at 10", rowTitles().length === 10, `rows=${rowTitles().length}`);
  check("limit: truncation said once", /showing 10/.test(echoText()) && /raise the limit or narrow the query/.test(echoText()), echoText());
  check("limit: not also as a cut note", !/more matches were cut/.test(echoText()), echoText());

  /* -------- ranking: the cases that were wrong ----------------------------- */
  app.switchTab("fn");
  await settle("reascript");
  app.state.limit = "50";
  app.setQuery("count tracks");
  check("rank: 'count tracks' leads with CountTracks", rowTitles()[0] === "CountTracks", rowTitles().slice(0, 3).join(", "));
  app.setQuery("track fx param");
  check("rank: 'track fx param' leads with TrackFX_GetParam", rowTitles()[0] === "TrackFX_GetParam", rowTitles().slice(0, 3).join(", "));
  app.setQuery("insert envelope point");
  check("rank: 'insert envelope point' leads with InsertEnvelopePoint", rowTitles()[0] === "InsertEnvelopePoint", rowTitles().slice(0, 3).join(", "));
  app.switchTab("ac");
  await settle("actions");
  app.setQuery("zoom time selection");
  check("rank: actions favour the closest name", /Zoom time selection/.test(rowTitles()[0] || ""), rowTitles()[0]);
  app.setQuery("marker");
  check("rank: action names still all-keyword first", /marker/i.test(rowTitles()[0] || ""), rowTitles()[0]);

  /* -------- layout: static shape of the document --------------------------- */
  check("layout: search bar sits in the left column", html.indexOf('class="left"') < html.indexOf('class="toolbar"') && html.indexOf('class="toolbar"') < html.indexOf('id="list"'), "toolbar must be inside .left");
  check("layout: no stats line beside the title", !html.includes('id="provenance"'));
  check("layout: parameters use the tight grid", html.includes('class: "plist"') && /\.plist \{/.test(html));
  check("layout: magnifier icon, no placeholder text", html.includes('class="mag"') && !/placeholder="Search/.test(html));

  // hash round-trip
  app.setQuery("marker");
  check("hash: written", location.hash.includes("tab=") && location.hash.includes("q=marker"), location.hash);
  check("hash: no raw spaces", !location.hash.includes(" "), location.hash);

  // keyboard: arrow moves selection
  app.setQuery("envelope");
  const before = app.state.sel;
  app.move(1);
  check("keys: ArrowDown selects a row", app.state.sel && app.state.sel !== before, `before=${before} after=${app.state.sel}`);

  // input handler debounces into runSearch (actions tab, so compare to actions)
  q().value = "item normalize";
  q().dispatch("input", { target: { value: "item normalize" } });
  await new Promise((r) => setTimeout(r, 260));
  check("input: typing updates state", app.state.q === "item normalize", app.state.q);
  check("input: rows follow", JSON.stringify(rowTitles().slice(0, 10)) === JSON.stringify(serverAc("item normalize")), rowTitles()[0]);
})();

  /* -------- empty state: the dataset stamp, and recent searches ------------- */
  app.state.tab = "fn";
  app.setQuery("");
  check("stamp: the ReaScript build", /Built from REAPER v7\.85\/macOS-arm64/.test(listText()), listText().slice(0, 160));
  app.state.tab = "ac";
  app.render();
  check("stamp: the actions build", /Built from REAPER v7\.85\/macOS-arm64/.test(listText()), listText().slice(0, 160));
  app.state.tab = "jx";
  app.render();
  check("stamp: a non-build origin, shown as written", /reaper\.fm\/sdk\/js docs, no REAPER version stated/.test(listText()), listText().slice(0, 160));
  const stampedBy = app.RAW.jsfx.generated_by;
  delete app.RAW.jsfx.generated_by;
  app.render();
  check("stamp: says so when nothing was recorded", /records no REAPER version/.test(listText()), listText().slice(0, 160));
  app.RAW.jsfx.generated_by = stampedBy;
  app.state.tab = "fn";
  app.render();
  check("recents: no example chips left", !listText().includes("track fx param") || listText().includes("recent"), listText());
  app.setQuery("count tracks");
  app.move(1);
  check("recents: opening a result records the query", JSON.parse(lsStore.get(app.LS_NS + "recent") || "{}").fn?.[0] === "count tracks", JSON.stringify(JSON.parse(lsStore.get(app.LS_NS + "recent") || "{}")));
  app.setQuery("");
  app.render();
  check("recents: offered in the empty state", listText().includes("recent") && listText().includes("count tracks"), listText().slice(0, 200));

  /* -------- persistence: opened from disk, files dropped once, remembered -- */
  const DATASETS = ["reascript", "actions", "jsfx"];
  const wipeMemory = () => {
    for (const k of DATASETS) { app.RAW[k] = null; app.IDX[k] = null; app.ORIGIN[k] = null; }
  };
  const fakeFile = (name) => ({ name, text: async () => fs.readFileSync("data/" + name, "utf8") });

  wipeMemory();
  lsStore.clear();
  fetchOK = false; // file://: nothing can be fetched
  location.protocol = "file:";
  app.state.tab = "jx";
  const loaded = await app.ensureDataset("jsfx", true);
  app.render();
  check("file://: fetch failure is not fatal", loaded === false);
  check("file://: panel asks for the files", listText().includes("Drop the data files once"), listText().slice(0, 120));
  check("file://: explains why", /opened from disk/.test(app.state.loadError || ""), app.state.loadError);

  await app.loadFiles([fakeFile("jsfx-api.json")]);
  check("drop: dataset adopted", !!app.RAW.jsfx);
  check("drop: notice says saved", /saved in this browser/.test(registry.get("about").textContent), registry.get("about").textContent);
  check("drop: notice mentions no server needed", /no server needed/.test(registry.get("about").textContent), registry.get("about").textContent);
  const storedPayload = localStorage.getItem(app.LS_NS + "jsfx");
  check("drop: written to localStorage", !!storedPayload);
  check("drop: payload is deflated", storedPayload && storedPayload.startsWith("d"), String(storedPayload).slice(0, 2));
  const rawLen = fs.readFileSync("data/jsfx-api.json", "utf8").length;
  check("drop: compression helps", storedPayload.length < rawLen * 0.6, `stored ${storedPayload.length} of ${rawLen} chars`);
  check("drop: meta recorded", app.savedMap().jsfx && app.savedMap().jsfx.file === "jsfx-api.json", JSON.stringify(app.savedMap()));

  // a fresh visit: no fetch possible, storage alone has to carry the page
  wipeMemory();
  const restored = await app.ensureDataset("jsfx", true);
  check("revisit: restored from storage", restored === true && app.ORIGIN.jsfx === "storage", String(app.ORIGIN.jsfx));
  check("revisit: searchable after restore", app.IDX.jsfx.total > 0, String(app.IDX.jsfx && app.IDX.jsfx.total));
  await app.loadFiles([fakeFile("reascript-api.json"), fakeFile("actions-api.json")]);
  wipeMemory();
  const all3 = await Promise.all([
    app.ensureDataset("reascript", true),
    app.ensureDataset("actions", true),
    app.ensureDataset("jsfx", true),
  ]);
  check("revisit: all three restore", all3.every(Boolean) && app.IDX.actions.total > 9000 && app.IDX.reascript.total > 2000,
    JSON.stringify([app.IDX.reascript && app.IDX.reascript.total, app.IDX.actions && app.IDX.actions.total, app.IDX.jsfx && app.IDX.jsfx.total]));
  check("footer: reports state after load", /saved in this browser|kept in this browser/.test(registry.get("about").textContent), registry.get("about").textContent);

  // the reason compression is there: 6.5 MB of JSON has to fit a 5 MB quota
  lsQuota = 5 * 1024 * 1024; // Safari-sized origin
  await app.loadFiles([fakeFile("reascript-api.json"), fakeFile("actions-api.json"), fakeFile("jsfx-api.json")]);
  check("5MB quota: all three still save", /files saved in this browser/.test(registry.get("about").textContent), registry.get("about").textContent);
  const used = [...lsStore].reduce((n, [, v]) => n + v.length, 0);
  check("5MB quota: comfortable headroom", used < 1.5 * 1024 * 1024, `${Math.round(used / 1024)} KB of the 5 MB used`);
  lsQuota = Infinity;

  // quota refused: the data still works, and the page says it was not saved
  await app.loadFiles([fakeFile("jsfx-api.json")]);
  const keepQuota = lsQuota;
  lsQuota = 4096;
  await app.loadFiles([fakeFile("reascript-api.json")]);
  check("quota: dataset still usable", !!app.RAW.reascript);
  check("quota: says it was not saved", /loaded but were not saved/.test(registry.get("about").textContent), registry.get("about").textContent);
  check("quota: names the full storage", /storage is full/.test(registry.get("about").textContent), registry.get("about").textContent);
  lsQuota = keepQuota;

  // a browser that forbids storage on file:// entirely (fresh instance, because
  // the page decides once whether storage is usable)
  const forbiddenStorage = {
    setItem() { throw new Error("SecurityError: file:// origin"); },
    getItem() { throw new Error("SecurityError: file:// origin"); },
    removeItem() { throw new Error("SecurityError: file:// origin"); },
  };
  const fresh = evalFreshInstance({ storage: forbiddenStorage, fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  const none = await fresh.ensureDataset("jsfx", true);
  check("no storage: load fails cleanly", none === false, String(none));
  check("no storage: message names the limit", /will not let a file:\/\/ page keep data/.test(fresh.state.loadError || ""), fresh.state.loadError);
  check("no storage: suggests a browser that allows it", /Chrome or Firefox/.test(fresh.state.loadError || ""), fresh.state.loadError);

  // clear the saved files
  app.state.tab = "fn";
  await app.ensureDataset("reascript", true);
  app.render();
  check("clear: button offered when something is saved", registry.get("storagebtn").style.display !== "none");
  registry.get("storagebtn").dispatch("click");
  check("clear: storage emptied", ![...lsStore.keys()].some((k) => k.startsWith(app.LS_NS) && k !== app.LS_NS + "meta"), [...lsStore.keys()].join(" "));
  check("clear: loaded data survives the clear this session", !!app.RAW.reascript);

  /* -------- layout: the resizable split and the width mode --------------- */
  const mainEl = registry.get("main");
  const gutterEl = registry.get("gutter");
  const widthBtn = registry.get("widthbtn");
  check("layout: compact is the default block", registry.get("app").classes.includes("compact"), registry.get("app").className);
  check("layout: split starts at the default", mainEl.style["--split"] === undefined, String(mainEl.style["--split"]));
  gutterEl.dispatch("pointerdown", { pointerId: 1, clientX: 0 });
  gutterEl.dispatch("pointermove", { clientX: 600 }); // 600 of the 1200-wide fake
  gutterEl.dispatch("pointerup", { pointerId: 1 });
  check("layout: drag sets the split", mainEl.style["--split"] === "50.0%", String(mainEl.style["--split"]));
  check("layout: the split is remembered", lsStore.get(app.LS_NS + "split") === "50.0%", String(lsStore.get(app.LS_NS + "split")));
  gutterEl.dispatch("keydown", { key: "ArrowLeft" });
  check("layout: arrow keys nudge the split", mainEl.style["--split"] === "48%", String(mainEl.style["--split"]));
  gutterEl.dispatch("dblclick");
  check("layout: double-click resets it", mainEl.style["--split"] === undefined && lsStore.get(app.LS_NS + "split") === undefined, String(mainEl.style["--split"]));
  check("layout: the width toggle names wide", widthBtn.textContent === "layout: compact", widthBtn.textContent);
  widthBtn.dispatch("click");
  check("layout: wide removes the block", !registry.get("app").classes.includes("compact") && widthBtn.textContent === "layout: wide", registry.get("app").className);
  check("layout: the width mode is remembered", lsStore.get(app.LS_NS + "width") === "wide", String(lsStore.get(app.LS_NS + "width")));
  widthBtn.dispatch("click");
  check("layout: back to compact", registry.get("app").classes.includes("compact"), registry.get("app").className);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} checks passed, ${failed.length} failed`);
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.label}${r.ok ? "" : " — " + r.detail}`);
process.exit(failed.length ? 1 : 0);
