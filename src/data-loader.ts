import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface JSFXFunction {
  name: string;
  category: string;
  description: string;
  signature?: string;
  parameters?: Array<{ name: string; type: string; description: string }>;
  returns?: string;
  examples?: string[];
}

export interface Signature {
  return_values: Array<{
    type: string;
    name: string | null;
    description?: string;
  }>;
  name: string;
  parameters: Array<{
    type: string;
    name: string;
    optional: boolean;
    description?: string;
  }>;
}

export interface ReaScriptFunction {
  name: string;
  namespace: string;
  signature: string;
  description: string;
  signatures: {
    c?: Signature;
    eel2?: Signature;
    lua?: Signature;
    python?: Signature;
  };
  names?: {
    c?: string;
    eel2?: string;
    lua?: string;
    python?: string;
  };
  available_in: Array<"c" | "eel2" | "lua" | "python">;
}

export interface JSFXFunction {
  name: string;
  category: string;
  description: string;
  signature?: string;
  parameters?: Array<{ name: string; type: string; description: string }>;
  returns?: string;
  examples?: string[];
}

export interface ReaWrapMethod {
  name: string;
  class: string;
  description: string;
  signature: string;
  parameters: Array<{
    name: string;
    type: string;
    description?: string;
    optional: boolean;
  }>;
  returns: Array<{
    type: string;
    description?: string;
  }>;
  category?: string;
}

export interface ReaWrapMethod {
  name: string;
  class: string;
  description: string;
  signature: string;
  parameters: Array<{
    name: string;
    type: string;
    description?: string;
    optional: boolean;
  }>;
  returns: Array<{
    type: string;
    description?: string;
  }>;
  category?: string;
}

export class DataLoader {
  private jsfxData: any = null;
  private reascriptData: any = null;
  private reawrapData: any = null;

  private dataDir = path.join(__dirname, "../data");

  loadJSFX(): any {
    if (this.jsfxData) return this.jsfxData;
    const filePath = path.join(this.dataDir, "jsfx-api.json");
    if (fs.existsSync(filePath)) {
      this.jsfxData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return this.jsfxData;
  }

  loadReaScript(): any {
    if (this.reascriptData) return this.reascriptData;
    const filePath = path.join(this.dataDir, "reascript-api.json");
    if (fs.existsSync(filePath)) {
      this.reascriptData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return this.reascriptData;
  }

  loadReaWrap(): any {
    if (this.reawrapData) return this.reawrapData;
    const filePath = path.join(this.dataDir, "reawrap-api.json");
    if (fs.existsSync(filePath)) {
      this.reawrapData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return this.reawrapData;
  }

  getJSFXFunction(name: string): JSFXFunction | null {
    const data = this.loadJSFX();
    if (!data || !data.functions) return null;
    return data.functions.find((f: JSFXFunction) => f.name === name) || null;
  }

  searchJSFXFunctions(query: string): JSFXFunction[] {
    const data = this.loadJSFX();
    if (!data || !data.functions) return [];

    // Language aliases map for extracting from query (jsfx/eel2)
    const LANGUAGE_ALIASES: Record<string, string[]> = { eel2: ["eel", "eel2", "jsfx"] };

    // Split query into keywords
    const rawKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

    // Extract language from keywords if present (JSFX uses eel2)
    let extractedLang: string | null = null;
    for (const kw of rawKeywords) {
      for (const [lang, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        if (aliases.includes(kw)) {
          extractedLang = lang;
          break;
        }
      }
      if (extractedLang) break;
    }

    // If no valid keywords, return empty
    if (rawKeywords.length === 0) return [];

    const scoredResults: Array<{ func: JSFXFunction; score: number }> = data.functions.map((f: JSFXFunction) => {
      const lowerName = f.name.toLowerCase();
      const lowerDesc = (f.description || "").toLowerCase();
      const lowerCat = (f.category || "").toLowerCase();
      
      // Count how many keywords match in name, description, or category
      // Use word boundary matching for short keywords (<4 chars) to avoid false positives
      const matchedKeywords = rawKeywords.filter(keyword => {
        if (keyword.length < 4) {
          // For short keywords, require word boundary match
          const wordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRegex.test(f.name) || wordRegex.test(f.description || '') || wordRegex.test(f.category || '');
        }
        return lowerName.includes(keyword) || lowerDesc.includes(keyword) || lowerCat.includes(keyword);
      });

      // Exact name match bonus (case-insensitive)
      const exactMatchBonus = rawKeywords.filter(keyword => 
        lowerName === keyword
      ).length;

      return {
        func: f,
        score: matchedKeywords.length + (exactMatchBonus * 100)
      };
    }).filter((r: { func: JSFXFunction; score: number }) => r.score > 0);

    // Sort by score (descending), then alphabetically for ties
    scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.func.name.localeCompare(b.func.name);
    });

    return scoredResults.map(r => r.func);
  }

  getReaScriptFunction(name: string, language?: string): ReaScriptFunction | null {
    const data = this.loadReaScript();
    if (!data || !data.functions) return null;
    
    // Normalize language alias
    let normalizedLang = language?.toLowerCase();
    if (normalizedLang === "c++" || normalizedLang === "cpp") {
      normalizedLang = "c";
    } else if (normalizedLang === "eel" || normalizedLang === "jsfx") {
      normalizedLang = "eel2";
    } else if (normalizedLang === "py") {
      normalizedLang = "python";
    }
    
    const func = data.functions.find(
      (f: ReaScriptFunction) =>
        f.name === name || f.name.toLowerCase() === name.toLowerCase()
    );
    
    if (!func) return null;
    
    // If language specified, check if function has that signature
    if (normalizedLang && !func.available_in.includes(normalizedLang)) {
      return null;
    }
    
    return func || null;
  }

  searchReaScriptFunctions(query: string, language?: string): ReaScriptFunction[] {
    const data = this.loadReaScript();
    if (!data || !data.functions) return [];

    // Normalize language alias helper
    function normalizeLang(lang: string | undefined): string | undefined {
      if (!lang) return undefined;
      const l = lang.toLowerCase();
      if (l === "c++" || l === "cpp") return "c";
      if (l === "eel" || l === "jsfx") return "eel2";
      if (l === "py") return "python";
      return l;
    }

    // Language aliases map for extracting from query
    const LANGUAGE_ALIASES: Record<string, string[]> = {
      c: ["c", "cpp", "c++"],
      eel2: ["eel", "eel2", "jsfx"],
      lua: ["lua"],
      python: ["python", "py"]
    };

    // Split query into keywords
    const rawKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

    // Extract language from keywords if present
    let extractedLang: string | null = null;
    for (const kw of rawKeywords) {
      for (const [lang, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        if (aliases.includes(kw)) {
          extractedLang = lang;
          break;
        }
      }
      if (extractedLang) break;
    }

    // Use explicit language param if provided, otherwise use extracted from query
    const effectiveLang = normalizeLang(language || (extractedLang ?? undefined));

    // If no valid keywords, return empty
    if (rawKeywords.length === 0) return [];

    const scoredResults: Array<{ func: ReaScriptFunction; score: number }> = data.functions.map((f: ReaScriptFunction) => {
      const lowerName = f.name.toLowerCase();
      const lowerDesc = (f.description || "").toLowerCase();
      
      // Count how many keywords match this function in name or description
      // Use word boundary matching for short keywords (<4 chars) to avoid false positives
      const matchedKeywords = rawKeywords.filter(keyword => {
        if (keyword.length < 4) {
          // For short keywords, require word boundary match
          const wordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
          return wordRegex.test(f.name) || wordRegex.test(f.description || '');
        }
        return lowerName.includes(keyword) || lowerDesc.includes(keyword);
      });

      // Exact name match bonus (case-insensitive)
      const exactMatchBonus = rawKeywords.filter(keyword => 
        lowerName === keyword
      ).length;

      return {
        func: f,
        score: matchedKeywords.length + (exactMatchBonus * 100)
      };
    }).filter((r: { func: ReaScriptFunction; score: number }) => r.score > 0); // Only include functions with at least one match

    // Sort by score (descending), then alphabetically for ties
    scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.func.name.localeCompare(b.func.name);
    });

    let results = scoredResults.map((r: { func: ReaScriptFunction; score: number }) => r.func);

    // Filter by language if specified (from param or extracted from query)
    if (effectiveLang && ["c", "eel2", "lua", "python"].includes(effectiveLang)) {
      results = results.filter(f => f.available_in.includes(effectiveLang as any));
    }

    return results;
  }

  getReaWrapMethod(className: string, methodName: string): any | null {
    const data = this.loadReaWrap();
    if (!data || !data.classes) return null;
    
    // Try exact match first, then case-insensitive
    let cls = data.classes.find((c: any) => c.name === className);
    if (!cls) {
      cls = data.classes.find(
        (c: any) => c.name.toLowerCase() === className.toLowerCase()
      );
    }
    if (!cls) return null;
    
    // Try exact match first, then case-insensitive
    let method = cls.methods.find((m: any) => m.name === methodName);
    if (!method) {
      method = cls.methods.find(
        (m: any) => m.name.toLowerCase() === methodName.toLowerCase()
      );
    }
    return method || null;
  }

  searchReaWrapMethods(query: string): Array<{ class: string; name: string; method: any }> {
    const data = this.loadReaWrap();
    if (!data || !data.classes) return [];

    // Language aliases map for extracting from query (lua)
    const LANGUAGE_ALIASES: Record<string, string[]> = { lua: ["lua"] };

    // Split query into keywords
    const rawKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);

    // Extract language from keywords if present (ReaWrap is Lua-only)
    let extractedLang: string | null = null;
    for (const kw of rawKeywords) {
      for (const [lang, aliases] of Object.entries(LANGUAGE_ALIASES)) {
        if (aliases.includes(kw)) {
          extractedLang = lang;
          break;
        }
      }
      if (extractedLang) break;
    }

    // If no valid keywords, return empty
    if (rawKeywords.length === 0) return [];

    const scoredResults: Array<{ class: string; name: string; method: any; score: number }> = [];
    for (const cls of data.classes) {
      for (const method of cls.methods) {
        const lowerName = method.name.toLowerCase();
        const lowerDesc = (method.description || "").toLowerCase();
        const lowerClassName = cls.name.toLowerCase();
        
        // Count how many keywords match in method name, description, or class name
        // Use word boundary matching for short keywords (<4 chars) to avoid false positives
        const matchedKeywords = rawKeywords.filter(keyword => {
          if (keyword.length < 4) {
            // For short keywords, require word boundary match
            const wordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return wordRegex.test(method.name) || wordRegex.test(method.description || '') || wordRegex.test(cls.name);
          }
          return lowerName.includes(keyword) || lowerDesc.includes(keyword) || lowerClassName.includes(keyword);
        });

        // Exact name match bonus (case-insensitive)
        const exactMatchBonus = rawKeywords.filter(keyword => 
          lowerName === keyword || lowerClassName === keyword
        ).length;

        if (matchedKeywords.length > 0) {
          scoredResults.push({
            class: cls.name,
            name: method.name,
            method,
            score: matchedKeywords.length + (exactMatchBonus * 100)
          });
        }
      }
    }

    // Sort by score (descending), then alphabetically for ties
    scoredResults.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return `${a.class}.${a.name}`.localeCompare(`${b.class}.${b.name}`);
    });

    // Remove score fields before returning
    const results = scoredResults.map(r => ({
      class: r.class,
      name: r.name,
      method: r.method
    }));

    return results;
  }
}

