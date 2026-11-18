// "Did you mean" ranking.
//
// Agents reach for these tools with a name they believe in but have not verified,
// so a plain "not found" wastes a round trip. Two very different miss patterns
// have to be caught at once:
//
//   * wrong word order / guessed wording
//       TrackInsertMediaItemCount  ->  CountTrackMediaItems
//     (edit distance is huge here, token overlap is high)
//   * typo in an otherwise correct name
//       TrackFX_GetPraram  ->  TrackFX_GetParam
//     (token overlap fails on the mistyped token, edit distance is tiny)
//
// So the score is the better of token Dice similarity and normalised edit
// distance, rather than either one alone.

/**
 * Split an API identifier into lowercase tokens: TrackFX_GetParam -> track, fx, get, param.
 *
 * Trailing 's' is stripped from longer tokens so the frequent singular/plural
 * mismatch (GetMediaItem vs GetMediaItems, item vs items) does not silently
 * cost a candidate its token overlap.
 */
/** Case- and separator-free form: the key that makes 'TrackFX-GetParam' resolve. */
export function compactForm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

/** Cheap English-ish stem: items -> item, takes -> take, but leaves "fx", "s" alone. */
export function stem(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}


/** Levenshtein distance, single-row DP. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity between a query and one candidate identifier. */
export function similarity(input: string, candidate: string): number {
  if (!input || !candidate) return 0;
  const a = input.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 1;

  // Tokenize the RAW strings: the camelCase boundaries are what make the tokens
  // meaningful, so lowercasing first would collapse every identifier to one
  // token and silently disable this whole signal.
  const ta = tokenize(input);
  const tb = tokenize(candidate);
  let tokenScore = 0;
  if (ta.length && tb.length) {
    const setB = new Set(tb);
    let shared = 0;
    for (const t of new Set(ta)) if (setB.has(t)) shared++;
    tokenScore = (2 * shared) / (ta.length + tb.length);
  }

  const longest = Math.max(a.length, b.length);
  const editScore = longest ? 1 - editDistance(a, b) / longest : 0;

  // A name typed as a fragment of the real one ("GetParam" for
  // "TrackFX_GetParam") scores poorly on both measures on its own. The bonus is
  // gated on how much of the longer string the shorter one covers, otherwise a
  // short common fragment ("insertmedia" inside a long query) outranks the name
  // the caller actually meant.
  const shorter = Math.min(a.length, b.length);
  const coverage = longest ? shorter / longest : 0;
  const substringBonus = coverage >= 0.5 && (b.includes(a) || a.includes(b)) ? 0.15 : 0;

  return Math.min(1, Math.max(tokenScore, editScore) + substringBonus);
}

/**
 * Rank `candidates` against `input`. Only scores at or above `threshold` are
 * returned, so an unrelated query yields no suggestions rather than noise.
 */
export function rankCandidates(
  input: string,
  candidates: Iterable<string>,
  options: { limit?: number; threshold?: number } = {}
): string[] {
  const limit = options.limit ?? 5;
  const threshold = options.threshold ?? 0.45;
  if (!input || !input.trim()) return [];

  const scored: Array<{ name: string; score: number }> = [];
  for (const candidate of candidates) {
    const score = similarity(input, candidate);
    if (score >= threshold) scored.push({ name: candidate, score });
  }

  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return x.name.localeCompare(y.name);
  });

  return scored.slice(0, limit).map((s) => s.name);
}
