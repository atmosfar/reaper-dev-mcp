// Shared argument validation.
//
// An agent that has never seen this server will send plausible variations:
// `functionName` instead of `function_name`, `api:"lua"` when lua is a language,
// `max_results` instead of `limit`. Rejecting those outright costs a round trip
// for a mistake that has exactly one reasonable interpretation, so names are
// matched case/separator-insensitively against a declared alias set.
//
// Ambiguity is never guessed at: a value that is wrong for its parameter
// (`api:"lua"`) fails with a message naming the parameter, listing the valid
// values, and pointing at the parameter that does accept that value.

import { rankCandidates } from "./suggest.js";

export type ArgKind = "string" | "integer" | "enum";

export interface ArgSpec {
  name: string;
  kind: ArgKind;
  required?: boolean;
  default?: string | number;
  /** Accepted alternate spellings, matched after case/separator removal. */
  names?: string[];
  /** Values the caller may pass that mean one of `values`. */
  alias?: Record<string, string>;
  /**
   * Explains, in the error, which parameter the caller probably meant instead,
   * and supplies the corrected call. Keyed by lower-cased value text.
   */
  valueHint?: Record<string, { message: string; patch?: Record<string, unknown> }>;
  values?: string[];
  min?: number;
  max?: number;
  minLength?: number;
}

export interface ArgSuccess {
  ok: true;
  values: Record<string, any>;
  notes: string[];
}

export interface ArgFailure {
  ok: false;
  error: string;
  did_you_mean?: string[];
  next_step?: string;
  /**
   * The caller's own parameters, corrected — so a handler can hand back a call
   * that is right apart from the tool name, rather than prose about what to fix.
   */
  suggested_args?: Record<string, any>;
}

export type ArgOutcome = ArgSuccess | ArgFailure;

const normKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

function describe(spec: ArgSpec): string {
  const type = spec.kind === "integer" ? "number" : spec.kind === "enum" ? `'${spec.values!.join("' | '")}'` : "string";
  const req = spec.required ? "required" : `optional, default ${JSON.stringify(spec.default ?? null)}`;
  return `'${spec.name}' (${type}, ${req})`;
}

export function formatExample(example: Record<string, any>): string {
  return JSON.stringify(example);
}

/**
 * Where a rejected value probably belongs. `api:"lua"` is the headline case:
 * telling the caller that lua is a language, not an api, is what turns a wrong
 * first call into a correct second one.
 */
function crossParameterHint(spec: ArgSpec, value: string): { message: string; patch?: Record<string, unknown> } | null {
  return spec.valueHint?.[value.toLowerCase()] ?? null;
}

export function validateArgs(
  raw: unknown,
  specs: ArgSpec[],
  example: Record<string, any>
): ArgOutcome {
  const notes: string[] = [];
  const exampleText = formatExample(example);
  const accepted = specs.map((s) => s.name);
  const acceptedText = accepted.length ? accepted.join(", ") : "none";

  const fail = (
    error: string,
    extra: { did_you_mean?: string[]; next_step?: string; suggested_args?: Record<string, any> } = {}
  ): ArgFailure => ({
    ok: false,
    error: `${error}\nExpected: ${specs.map(describe).join("; ")}\nExample: ${exampleText}`,
    did_you_mean: extra.did_you_mean,
    suggested_args: extra.suggested_args,
    next_step:
      extra.next_step ?? `Re-send the call using only the accepted parameters, e.g. ${exampleText}`,
  });

  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail(
      `Parameters must be a JSON object, got ${Array.isArray(raw) ? "an array" : typeof raw}.`
    );
  }

  const incoming = raw as Record<string, unknown>;

  // Map every accepted spelling back to its canonical parameter name.
  const keyMap = new Map<string, string>();
  for (const spec of specs) {
    for (const alias of [spec.name, ...(spec.names ?? [])]) {
      const norm = normKey(alias);
      if (!keyMap.has(norm)) keyMap.set(norm, spec.name);
    }
  }

  // An unrecognised parameter is the second most common mistake after a bad
  // name. Ignoring one silently turns a typo'd filter into "no results", which
  // reads to the caller as an empty database rather than a broken call.
  const sourceFor = new Map<string, string>();
  const unknown: string[] = [];
  for (const key of Object.keys(incoming)) {
    const canonical = keyMap.get(normKey(key));
    if (canonical) sourceFor.set(canonical, key);
    else unknown.push(key);
  }

  if (unknown.length > 0) {
    return fail(
      accepted.length === 0
        ? `This tool takes no parameters, but received ${unknown.map((u) => `'${u}'`).join(", ")}.`
        : `Unknown parameter${unknown.length > 1 ? "s" : ""}: ${unknown
            .map((u) => `'${u}'`)
            .join(", ")}. Accepted: ${acceptedText}.`,
      {
        // With at most a handful of accepted parameters, listing them ranked by
        // closeness beats guessing nothing.
        did_you_mean: accepted.length
          ? rankCandidates(unknown[0], accepted, { limit: 3, threshold: 0 })
          : undefined,
        next_step: `Re-send with ${acceptedText} only, e.g. ${exampleText}`,
      }
    );
  }

  const values: Record<string, any> = {};

  for (const spec of specs) {
    const sourceKey = sourceFor.get(spec.name);
    const rawValue = sourceKey === undefined ? undefined : incoming[sourceKey];

    if (rawValue === undefined || rawValue === null || rawValue === "") {
      if (spec.required) {
        return fail(
          `Missing required parameter '${spec.name}'. ${
            spec.kind === "enum"
              ? `It must be one of ${spec.values!.map((v) => `'${v}'`).join(" | ")}.`
              : ""
          }`,
          { next_step: `Add '${spec.name}' and re-send, e.g. ${exampleText}` }
        );
      }
      if (spec.default !== undefined) values[spec.name] = spec.default;
      continue;
    }

    if (sourceKey !== spec.name) {
      notes.push(`'${sourceKey}' was read as '${spec.name}'.`);
    }

    if (spec.kind === "enum") {
      if (typeof rawValue !== "string" && typeof rawValue !== "number") {
        return fail(`'${spec.name}' must be a string, got ${typeof rawValue}.`);
      }
      const rawText = String(rawValue).trim();
      const lowered = rawText.toLowerCase();
      const exact = spec.values!.includes(rawText) ? rawText : undefined;
      const byCase = spec.values!.find((v) => v.toLowerCase() === lowered);
      const byAlias = spec.alias?.[lowered];
      const resolved = exact ?? byCase ?? byAlias;

      if (resolved === undefined) {
        const hint = crossParameterHint(spec, rawText);
        const near = rankCandidates(rawText, spec.values!, { limit: 3, threshold: 0.3 });
        // The caller's own parameters, with the misunderstanding repaired, so the
        // handler can return a call that is correct apart from the tool name.
        const current: Record<string, any> = {};
        for (const [canonical, key] of sourceFor) current[canonical] = incoming[key];
        return fail(
          `'${spec.name}' must be one of ${spec.values!.map((v) => `'${v}'`).join(" | ")}; got '${rawText}'.` +
            (hint ? ` ${hint.message}` : ""),
          {
            did_you_mean: near,
            ...(hint?.patch ? { suggested_args: { ...current, ...hint.patch } } : {}),
          }
        );
      }
      if (resolved !== rawText) {
        notes.push(`'${spec.name}' was normalised from '${rawText}' to '${resolved}'.`);
      }
      values[spec.name] = resolved;
      continue;
    }

    if (spec.kind === "integer") {
      let num: number;
      if (typeof rawValue === "number") {
        num = rawValue;
      } else if (typeof rawValue === "string" && rawValue.trim() !== "" && Number.isFinite(Number(rawValue))) {
        num = Number(rawValue);
        notes.push(`'${spec.name}' was coerced from the string '${rawValue}' to a number.`);
      } else {
        return fail(
          `'${spec.name}' must be an integer, got ${typeof rawValue === "string" ? `'${rawValue}'` : typeof rawValue}.`
        );
      }
      if (!Number.isFinite(num)) return fail(`'${spec.name}' must be a finite integer.`);

      const min = spec.min ?? 1;
      const max = spec.max ?? Number.MAX_SAFE_INTEGER;
      let clamped = Math.trunc(num);
      if (clamped < min || clamped > max) {
        // Snap to the nearest bound rather than to the default: a caller asking
        // for 5000 results wants as many as possible, not fewer than default.
        const bound = clamped < min ? min : max;
        notes.push(
          `'${spec.name}' of ${num} is outside ${min}..${max}; used ${bound}, the nearest allowed value.`
        );
        clamped = bound;
      }
      values[spec.name] = clamped;
      continue;
    }

    // string
    let text: string;
    if (typeof rawValue === "string") {
      text = rawValue;
    } else if (
      typeof rawValue === "number" ||
      typeof rawValue === "boolean" ||
      typeof rawValue === "bigint"
    ) {
      // Always harmless to accept: an action id sent as 40064 rather than
      // "40064". Refusing it only wastes the caller's turn.
      text = String(rawValue);
      notes.push(`'${spec.name}' was coerced from ${typeof rawValue} ${rawValue} to the string '${text}'.`);
    } else {
      return fail(
        `'${spec.name}' must be a string, got ${Array.isArray(rawValue) ? "an array" : typeof rawValue}.`
      );
    }

    text = text.trim();
    if (!text) return fail(`'${spec.name}' must not be empty.`);

    if (spec.minLength && text.length < spec.minLength) {
      return fail(
        `'${spec.name}' must be at least ${spec.minLength} characters; '${text}' is too short to be meaningful here.`
      );
    }

    values[spec.name] = text;
  }

  return { ok: true, values, notes };
}
