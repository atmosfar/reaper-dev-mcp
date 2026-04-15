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
    const lowerQuery = query.toLowerCase();
    return data.functions.filter(
      (f: JSFXFunction) =>
        f.name.toLowerCase().includes(lowerQuery) ||
        f.description.toLowerCase().includes(lowerQuery) ||
        f.category.toLowerCase().includes(lowerQuery)
    );
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
    
    // Normalize language alias
    let normalizedLang = language?.toLowerCase();
    if (normalizedLang === "c++" || normalizedLang === "cpp") {
      normalizedLang = "c";
    } else if (normalizedLang === "eel" || normalizedLang === "jsfx") {
      normalizedLang = "eel2";
    } else if (normalizedLang === "py") {
      normalizedLang = "python";
    }
    
    const lowerQuery = query.toLowerCase();
    let results = data.functions.filter(
      (f: ReaScriptFunction) =>
        f.name.toLowerCase().includes(lowerQuery) ||
        (f.description && f.description.toLowerCase().includes(lowerQuery)) ||
        (f.namespace && f.namespace.toLowerCase().includes(lowerQuery))
    );
    
    // Filter by language if specified
    if (normalizedLang && ["c", "eel2", "lua", "python"].includes(normalizedLang)) {
      results = results.filter(
        (f: ReaScriptFunction) => f.available_in.includes(normalizedLang as "c" | "eel2" | "lua" | "python")
      );
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
    const lowerQuery = query.toLowerCase();
    const results: Array<{ class: string; name: string; method: any }> = [];
    for (const cls of data.classes) {
      for (const method of cls.methods) {
        if (
          method.name.toLowerCase().includes(lowerQuery) ||
          (method.description && method.description.toLowerCase().includes(lowerQuery)) ||
          cls.name.toLowerCase().includes(lowerQuery)
        ) {
          results.push({ class: cls.name, name: method.name, method });
        }
      }
    }
    return results;
  }
}

