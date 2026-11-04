import { describe, it, expect, beforeAll } from "vitest";
import { DataLoader } from "./data-loader.js";

describe("DataLoader", () => {
  let loader: DataLoader;

  beforeAll(() => {
    loader = new DataLoader();
  });

  describe("JSFX Functions", () => {
    it("should load JSFX data", () => {
      const data = loader.loadJSFX();
      expect(data).toBeDefined();
      expect(data?.functions).toBeDefined();
      expect(Array.isArray(data?.functions)).toBe(true);
    });

    it("should find JSFX function by name", () => {
      const func = loader.getJSFXFunction("sin");
      expect(func).toBeDefined();
      expect(func?.name).toBe("sin");
    });

    it("should return null for non-existent JSFX function", () => {
      const func = loader.getJSFXFunction("nonexistent_function_xyz");
      expect(func).toBeNull();
    });

    it("should search JSFX functions", () => {
      const results = loader.searchJSFXFunctions("sin");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((f) => f.name === "sin")).toBe(true);
    });
  });

  describe("ReaScript Functions", () => {
    it("should load ReaScript data", () => {
      const data = loader.loadReaScript();
      expect(data).toBeDefined();
      expect(data?.functions).toBeDefined();
      expect(Array.isArray(data?.functions)).toBe(true);
    });

    it("should find ReaScript function by name", () => {
      const func = loader.getReaScriptFunction("TrackFX_GetParam");
      expect(func).toBeDefined();
      expect(func?.name).toBe("TrackFX_GetParam");
    });

    it("should return null for non-existent ReaScript function", () => {
      const func = loader.getReaScriptFunction("NonexistentFunctionXYZ");
      expect(func).toBeNull();
    });

    it("should search ReaScript functions", () => {
      const results = loader.searchReaScriptFunctions("TrackFX");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((f) => f.name.includes("TrackFX"))).toBe(true);
    });

    it("should handle case-insensitive search", () => {
      const results = loader.searchReaScriptFunctions("trackfx");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("REAPER Actions", () => {
    it("should load actions data", () => {
      const data = loader.loadActions();
      expect(data).toBeDefined();
      expect(Array.isArray(data?.actions)).toBe(true);
      expect(Array.isArray(data?.sections)).toBe(true);
      expect(data!.actions.length).toBeGreaterThan(0);
    });

    it("should find an action by id", () => {
      const matches = loader.getAction("40064");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.map((a) => a.name)).toContain(
        "Envelope: Insert new point at current position to all visible track envelopes (do not remove nearby points)"
      );
    });

    it("should return one row per section sharing an id", () => {
      // 41075 is the same numeric id for two unrelated actions.
      const matches = loader.getAction("41075");
      expect(matches.length).toBeGreaterThan(1);
      const sections = matches.map((a) => a.section);
      expect(new Set(sections).size).toBe(sections.length);
      const names = matches.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("should narrow to a single section when one is given", () => {
      const matches = loader.getAction("41075", "MIDI Editor");
      expect(matches.length).toBe(1);
      expect(matches[0].name).toContain("Set length for next inserted note");
    });

    it("should return no rows for an unknown id", () => {
      expect(loader.getAction("99999999")).toEqual([]);
    });

    it("should enrich results with section invoke metadata", () => {
      const match = loader.getAction("41075", "Main")[0];
      expect(match.invoke).toContain("Main_OnCommand");
      expect(Array.isArray(match.contexts)).toBe(true);
      expect(match.contexts).toContain("Main");
    });

    it("should resolve section contexts to their canonical section", () => {
      expect(loader.resolveActionSection("Main (alt-3)")).toBe("Main");
      expect(loader.resolveActionSection("midi editor")).toBe("MIDI Editor");
      expect(loader.resolveActionSection("Not A Section")).toBeNull();
    });

    it("should search actions by name", () => {
      const results = loader.searchActions("envelope insert point");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((a) => /envelope/i.test(a.name))).toBe(true);
    });

    it("should prefer results matching every keyword", () => {
      const query = "insert new point at current position";
      const keywords = query.split(/\s+/);
      const results = loader.searchActions(query);
      expect(results.length).toBeGreaterThan(0);
      for (const action of results) {
        for (const kw of keywords) {
          expect(action.name.toLowerCase()).toContain(kw);
        }
      }
    });

    it("should treat a vendor word in the query as a source filter", () => {
      const results = loader.searchActions("marker sws");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((a) => a.source === "sws")).toBe(true);
    });

    it("should filter by section", () => {
      const results = loader.searchActions("insert", { section: "MIDI Editor" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((a) => a.section === "MIDI Editor")).toBe(true);
    });

    it("should match REAPER slash category families", () => {
      const results = loader.searchActions("toolbar", { category: "SWS" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((a) => a.category?.startsWith("SWS/"))).toBe(true);
    });

    it("should exclude per-install ReaScript actions", () => {
      for (const action of loader.searchActions("script")) {
        expect(action.name).not.toMatch(/^Script: /i);
      }
    });

    it("should summarize the dataset in the overview", () => {
      const overview = loader.getActionsOverview();
      expect(overview).toBeDefined();
      expect(overview.total_actions).toBeGreaterThan(0);
      expect(overview.counts_by_source).toHaveProperty("reaper");
      expect(overview.counts_by_source).toHaveProperty("sws");
      expect(overview.important_caveats.length).toBeGreaterThan(0);
    });
  });

});

