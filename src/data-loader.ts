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

// Shared helper: match keywords against text fields with word boundary logic
function matchKeywords(
  rawKeywords: string[],
  fields: string[]
): { matchedCount: number; exactBonus: number } {
  let matchedCount = 0;
  let exactBonus = 0;

  for (const keyword of rawKeywords) {
    const lowerKeyword = keyword.toLowerCase();
    let matched = false;

    for (const field of fields) {
      const lowerField = field.toLowerCase();
      if (lowerField === lowerKeyword) {
        exactBonus++;
        matched = true;
        break;
      }

      if (keyword.length < 4) {
        // Word boundary match for short keywords
        const wordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (wordRegex.test(field)) {
          matched = true;
          break;
        }
      } else {
        // Substring match for longer keywords
        if (lowerField.includes(lowerKeyword)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) matchedCount++;
  }

  return { matchedCount, exactBonus };
}

export interface Action {
  id: string;
  section: string;
  name: string;
  category: string | null;
  source: "reaper" | "sws";
}

export interface ActionSection {
  name: string;
  contexts: string[];
  action_count: number;
  invoke: string | null;
  notes: string | null;
}

export interface ActionDetail extends Action {
  contexts: string[];
  invoke: string | null;
  notes: string | null;
}

export interface ActionSearchFilters {
  section?: string;
  category?: string;
  source?: string;
}

export class DataLoader {
  private jsfxData: any = null;
  private reascriptData: any = null;
  private actionsData: any = null;

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
      const { matchedCount, exactBonus } = matchKeywords(rawKeywords, [
        f.name,
        f.description || '',
        f.category || ''
      ]);

      return {
        func: f,
        score: matchedCount + (exactBonus * 100)
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
      const { matchedCount, exactBonus } = matchKeywords(rawKeywords, [
        f.name,
        f.description || ''
      ]);

      return {
        func: f,
        score: matchedCount + (exactBonus * 100)
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

  // ---------------------------------------------------------------------------
  // REAPER actions (commands)
  //
  // Action IDs are only unique within a section, so every lookup keys on the
  // pair (section, id). ID 41075 is "[developer] Debug console" in Main but
  // "Set length for next inserted note: 1/4T" in the MIDI Editor.
  // ---------------------------------------------------------------------------

  loadActions(): any {
    if (this.actionsData) return this.actionsData;
    const filePath = path.join(this.dataDir, "actions-api.json");
    if (fs.existsSync(filePath)) {
      this.actionsData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    return this.actionsData;
  }

  getActionSections(): ActionSection[] {
    const data = this.loadActions();
    return data && data.sections ? data.sections : [];
  }

  // Resolve either a section name ("Main", "MIDI Editor") or one of the
  // contexts listed under that section ("Main (alt-3)") to the canonical
  // section name. Returns null when nothing matches.
  resolveActionSection(name: string): string | null {
    const target = name.trim().toLowerCase();
    for (const section of this.getActionSections()) {
      if (section.name.toLowerCase() === target) return section.name;
      if (section.contexts.some((c: string) => c.toLowerCase() === target)) return section.name;
    }
    return null;
  }

  private sectionMeta(name: string): ActionSection | undefined {
    return this.getActionSections().find((s: ActionSection) => s.name === name);
  }

  // A category filter understands REAPER's own slash families, so "SWS" also
  // matches "SWS/BR" and "Xenakios/SWS", while "Track" matches only "Track".
  private categoryMatches(category: string | null, filter: string): boolean {
    if (category === null) return false;
    const c = category.toLowerCase();
    const f = filter.trim().toLowerCase();
    return c === f || c.startsWith(f + "/") || c.includes("/" + f);
  }

  getAction(id: string, section?: string): ActionDetail[] {
    const data = this.loadActions();
    if (!data || !data.actions) return [];

    const wantedId = id.trim();
    let matches = data.actions.filter((a: Action) => a.id === wantedId);

    if (section) {
      const resolved = this.resolveActionSection(section);
      if (resolved) {
        matches = matches.filter((a: Action) => a.section === resolved);
      }
    }

    return matches.map((a: Action) => {
      const meta = this.sectionMeta(a.section);
      return {
        ...a,
        contexts: meta ? meta.contexts : [],
        invoke: meta ? meta.invoke : null,
        notes: meta ? meta.notes : null,
      };
    });
  }

  searchActions(query: string, filters: ActionSearchFilters = {}): Action[] {
    const data = this.loadActions();
    if (!data || !data.actions) return [];

    const rawKeywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    if (rawKeywords.length === 0) return [];

    // An explicit source parameter wins; otherwise a vendor word anywhere in
    // the query narrows the search to that source (like language extraction in
    // the API searches). The keyword itself is kept for text matching.
    let sourceFilter = filters.source ? filters.source.trim().toLowerCase() : null;
    if (!sourceFilter) {
      if (rawKeywords.some(k => k === "sws" || k === "xenakios")) sourceFilter = "sws";
      else if (rawKeywords.some(k => k === "reaper" || k === "stock")) sourceFilter = "reaper";
    }
    if (sourceFilter === "all" || sourceFilter === "any") sourceFilter = null;
    if (sourceFilter === "stock") sourceFilter = "reaper";

    const sectionFilter = filters.section ? this.resolveActionSection(filters.section) : null;
    const categoryFilter = filters.category || null;

    const scoredResults: Array<{ action: Action; score: number; matchedCount: number }> = [];
    for (const action of data.actions as Action[]) {
      if (sourceFilter && action.source !== sourceFilter) continue;
      if (sectionFilter && action.section !== sectionFilter) continue;
      if (categoryFilter && !this.categoryMatches(action.category, categoryFilter)) continue;

      const { matchedCount, exactBonus } = matchKeywords(rawKeywords, [
        action.name,
        action.category || "",
        action.id
      ]);

      if (matchedCount > 0) {
        scoredResults.push({
          action,
          matchedCount,
          score: matchedCount + (exactBonus * 100)
        });
      }
    }

    // Action names are natural-language sentences, so prefer results matching
    // every keyword (an implicit AND). If nothing matches all of them -- one
    // keyword being a typo, for instance -- fall back to partial matches rather
    // than returning nothing, since score order still puts closest hits first.
    const fullMatches = scoredResults.filter(r => r.matchedCount === rawKeywords.length);
    const candidates = fullMatches.length > 0 ? fullMatches : scoredResults;

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bySection = a.action.section.localeCompare(b.action.section);
      if (bySection !== 0) return bySection;
      return a.action.name.localeCompare(b.action.name);
    });

    return candidates.map(r => r.action);
  }

  getActionsOverview(): any {
    const data = this.loadActions();
    if (!data || !data.actions) return null;

    const categories: Record<string, number> = {};
    for (const action of data.actions as Action[]) {
      const key = action.category || "(no category)";
      categories[key] = (categories[key] || 0) + 1;
    }

    return {
      generated_by: data.generated_by,
      total_actions: data.total_actions,
      counts_by_source: data.counts_by_source,
      sections: data.sections,
      categories,
      important_caveats: [
        "Command IDs are unique only within a section - always disambiguate with the section. The same numeric ID refers to different actions in different sections.",
        "Sourced from an actions-list export of one specific REAPER install and its installed extensions, so IDs and coverage can differ between versions and installs.",
        "SWS actions are registered by an extension; call them via NamedCommandLookup('_NAME') rather than hardcoding the numeric ID where possible. ReverseNamedCommandLookup maps an ID back to that name.",
        "Non-SWS third party actions (Helgobox, ReaPack) and the per-install ReaScript actions (named 'Script: something.lua') were excluded from this dataset."
      ]
    };
  }
}

