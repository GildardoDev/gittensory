import { readBoundedResponseText } from "../signals/focus-manifest-loader";

/**
 * A single CODEOWNERS rule: a path pattern and the owners that follow it on the same line.
 * Owners are kept verbatim (still carrying the leading `@`, or an email) in file order; pattern
 * order is preserved so the loader can apply GitHub's last-match-wins semantics.
 */
export type CodeownersRule = { pattern: string; owners: string[] };

/** Candidate locations GitHub honors for a CODEOWNERS file, in the order GitHub resolves them. */
export const CODEOWNERS_FILE_CANDIDATES = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/**
 * Parse GitHub CODEOWNERS file content into ordered rules. PURE. Each non-empty, non-comment line is
 * `<pattern> <owner> [owner ...]` where an owner is `@user`, `@org/team`, or an email. Blank lines and
 * `#` comment lines are skipped; a line with a pattern but no owners is kept with an empty owners list
 * (GitHub treats it as "no owner for this pattern" — still a match that wins over earlier rules).
 */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Return the owners of the LAST matching rule for `path` (GitHub's last-match-wins semantics). PURE.
 * Returns [] when no rule matches (or the winning rule declares no owners). Mirrors the glob handling of
 * {@link matchesManifestPath} but adapts to CODEOWNERS semantics: a leading `/` anchors to the repo root,
 * a trailing `/` matches a directory prefix, `*` matches within a path segment, `**` matches across
 * segments, and a bare pattern with no slash matches a file/dir of that name anywhere in the tree.
 */
export function matchCodeowners(rules: CodeownersRule[], path: string): string[] {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return [];
  let owners: string[] = [];
  // Last-match-wins: scan in file order and keep overwriting, so the final matching rule prevails.
  for (const rule of rules) {
    if (matchesCodeownersPattern(normalizedPath, rule.pattern)) owners = rule.owners;
  }
  return owners;
}

function normalizePathForMatch(path: string): string {
  return String(path)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Test a normalized (no leading slash) path against a single CODEOWNERS pattern. Not exported; the
 * leading-slash anchor and bare-name "matches anywhere" rules are encoded here by building a regex.
 */
function matchesCodeownersPattern(normalizedPath: string, rawPattern: string): boolean {
  let pattern = rawPattern.replace(/\\/g, "/").trim();
  if (!pattern) return false;
  // `*` on its own (and `/`) own everything.
  if (pattern === "*" || pattern === "/" || pattern === "/*") return true;

  const anchored = pattern.startsWith("/");
  const dirOnly = pattern.endsWith("/");
  // A bare pattern (no internal slash, not anchored) matches anywhere in the tree, so it can be preceded
  // by any number of path segments. An anchored pattern is matched from the repo root.
  const matchesAnywhere = !anchored && !pattern.includes("/");
  pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return true;

  const regexBody = codeownersPatternToRegex(pattern);
  // A directory pattern (`dir/`) matches everything UNDER the directory (so a changed file `dir/x.ts`
  // matches, but a file literally named `dir` does not). A plain pattern matches the path exactly or as a
  // directory prefix (GitHub treats `foo/bar` as also owning `foo/bar/...`).
  const tail = dirOnly ? "/.*" : "(?:/.*)?";
  const prefix = matchesAnywhere ? "(?:.*/)?" : "";
  const regex = new RegExp(`^${prefix}${regexBody}${tail}$`);
  return regex.test(normalizedPath);
}

/**
 * Translate a CODEOWNERS glob body (slashes already trimmed off the ends) into a regex fragment.
 * `**` matches across path segments (including none), `*` matches within a single segment, and all other
 * regex metacharacters are escaped. A literal `**` is handled before `*` so it does not get double-expanded.
 */
function codeownersPatternToRegex(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**` => any characters across segment boundaries (greedy, may be empty).
        out += ".*";
        i += 1;
        // Swallow an immediately following `/` so `**/foo` matches `foo` at any depth (incl. root).
        if (pattern[i + 1] === "/") {
          out += "(?:/)?";
          i += 1;
        }
      } else {
        // `*` => any characters within a single path segment (no slash).
        out += "[^/]*";
      }
    } else {
      out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * Load a repo's CODEOWNERS rules from the public GitHub raw endpoint. Tries `.github/CODEOWNERS`, then
 * `CODEOWNERS`, then `docs/CODEOWNERS` (GitHub's resolution order) via the `HEAD` ref, mirroring
 * {@link fetchRepoFocusManifestFile} (same headers, the same bounded-read helper). Returns [] when no
 * file exists or any fetch fails — advisory reviewer routing must never throw on a network hiccup.
 *
 * No per-repo cache: this is called at most once per gate run (only when reviewerRoutingMode != off),
 * and the response is small; a signal-snapshot cache like the focus manifest's would add a DB round-trip
 * for no real saving here. The follow-up that adds auto_request can introduce one if call volume grows.
 */
export async function loadRepoCodeowners(env: Env, repoFullName: string): Promise<CodeownersRule[]> {
  void env;
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return [];
  const owner = repoFullName.slice(0, slash);
  const name = repoFullName.slice(slash + 1);
  for (const path of CODEOWNERS_FILE_CANDIDATES) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/HEAD/${path}`;
    try {
      const response = await fetch(url, { headers: { Accept: "text/plain", "User-Agent": "gittensory" } });
      if (response.ok) {
        const text = await readBoundedResponseText(response);
        if (text !== null && text.trim() !== "") return parseCodeowners(text);
      }
    } catch {
      // try the next candidate path
    }
  }
  return [];
}
