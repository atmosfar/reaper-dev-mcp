import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DataLoader } from "./data-loader.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("MCP Server Data Validation", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = path.join(__dirname, "../data");
  });

  describe("Data Files", () => {
    it("should have JSFX API data file", () => {
      const filePath = path.join(dataDir, "jsfx-api.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should have ReaScript API data file", () => {
      const filePath = path.join(dataDir, "reascript-api.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should have valid JSON in JSFX data file", () => {
      const filePath = path.join(dataDir, "jsfx-api.json");
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);
      expect(data).toHaveProperty("functions");
      expect(data).toHaveProperty("scraped_at");
    });

    it("should have valid JSON in ReaScript data file", () => {
      const filePath = path.join(dataDir, "reascript-api.json");
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content);
      expect(data).toHaveProperty("functions");
      expect(data).toHaveProperty("scraped_at");
    });

  });

  describe("JSFX Data Structure", () => {
    it("should have functions array", () => {
      const loader = new DataLoader();
      const data = loader.loadJSFX();
      expect(data?.functions).toBeDefined();
      expect(Array.isArray(data?.functions)).toBe(true);
      expect(data!.functions.length).toBeGreaterThan(0);
    });

    it("should have functions with required fields", () => {
      const loader = new DataLoader();
      const data = loader.loadJSFX();
      if (data?.functions && data.functions.length > 0) {
        const func = data.functions[0];
        expect(func).toHaveProperty("name");
        expect(typeof func.name).toBe("string");
      }
    });
  });

  describe("ReaScript Data Structure", () => {
    it("should have functions array", () => {
      const loader = new DataLoader();
      const data = loader.loadReaScript();
      expect(data?.functions).toBeDefined();
      expect(Array.isArray(data?.functions)).toBe(true);
      expect(data!.functions.length).toBeGreaterThan(0);
    });

    it("should have functions with required fields", () => {
      const loader = new DataLoader();
      const data = loader.loadReaScript();
      if (data?.functions && data.functions.length > 0) {
        const func = data.functions[0];
        expect(func).toHaveProperty("name");
        expect(typeof func.name).toBe("string");
      }
    });

    it("should have language information for functions", () => {
      const loader = new DataLoader();
      const func = loader.getReaScriptFunction("TrackFX_GetParam");
      if (func) {
        expect(func).toHaveProperty("available_in");
        expect(Array.isArray(func.available_in)).toBe(true);
      }
    });
  });

  describe("Actions Data Structure", () => {
    it("should have actions data file", () => {
      const filePath = path.join(dataDir, "actions-api.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should have valid JSON in actions data file", () => {
      const filePath = path.join(dataDir, "actions-api.json");
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      expect(data).toHaveProperty("actions");
      expect(data).toHaveProperty("sections");
      expect(data).toHaveProperty("scraped_at");
    });

    it("should have actions with required fields", () => {
      const loader = new DataLoader();
      const data = loader.loadActions();
      if (data?.actions?.length) {
        const action = data.actions[0];
        expect(action).toHaveProperty("id");
        expect(action).toHaveProperty("section");
        expect(action).toHaveProperty("name");
        expect(action).toHaveProperty("source");
        expect(["reaper", "sws"]).toContain(action.source);
      }
    });

    it("should have sections with contexts", () => {
      const loader = new DataLoader();
      const sections = loader.getActionSections();
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        expect(typeof section.name).toBe("string");
        expect(Array.isArray(section.contexts)).toBe(true);
        expect(section.contexts.length).toBeGreaterThan(0);
      }
    });

    it("should count every action in counts_by_section", () => {
      const loader = new DataLoader();
      const data = loader.loadActions();
      const sum = Object.values(data.counts_by_section).reduce((a: number, b: any) => a + b, 0);
      expect(sum).toBe(data.total_actions);
    });

    it("should exclude per-install script actions from the dataset", () => {
      const loader = new DataLoader();
      const data = loader.loadActions();
      const scripts = data.actions.filter((a: any) => /^Script: /i.test(a.name));
      expect(scripts).toEqual([]);
    });
  });

});

