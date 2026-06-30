// Unsafe-dynamic-execution analyzer. Flags an added (`+` diff) line that builds a COMMAND or CODE string by
// interpolation/concatenation and passes it straight to a dangerous execution sink — i.e. the classic
// command-injection / code-injection shape (`execSync(`git clone ${repo}`)`, `eval(`(${expr})`)`).
// Pure compute, no network, no external detector. Conservative by design (mirrors the redos analyzer): a pure
// string literal (`exec("ls -la")`), a literal-command spawn (`spawn("git", ["status"])`), or a bare identifier
// (`exec(cmd)`) are NEVER flagged, so the false-positive rate stays near zero. Reports ONLY the location, the
// sink name, and the kind — never the argument text. Line-cited via hunk headers, mirroring the redos analyzer.
//
// SCOPE (deliberate first-version contract — favors zero false positives + simplicity over exhaustive recall):
//   - LINE-LOCAL: each added line is scanned on its own (block-comment state is the only thing carried across
//     lines). It does NOT descend into template-literal `${...}` interpolations — the whole backtick template is
//     treated as a string, so a sink hidden INSIDE a `${}` expression (e.g. `const s = `${execSync(`x ${y}`)}`;`)
//     is intentionally NOT reported. This keeps the scanner a simple linear pass and never false-flags a
//     sink-looking substring inside a template/string.
//   - BEST-EFFORT member aliases: a member command sink is only treated as child_process for a known receiver
//     alias (CHILD_PROCESS_ALIASES); other/renamed aliases are intentionally not chased (avoids false positives
//     on `db.exec`, `fs.execFile`, etc.). Both limits trade some recall for precision and a bounded implementation.
import type { EnrichRequest, UnsafeExecFinding } from "../types.js";

// Every loop runs over an attacker-controlled patch, so each is bounded.
const MAX_FINDINGS = 25; // keep the brief bounded
const MAX_LINE_CHARS = 2000; // skip extraction on pathologically long lines (defensive)

type UnsafeExecScanLimits = {
  maxFindings?: number;
};

function* patchLines(patch: string): Generator<string> {
  let start = 0;
  while (start <= patch.length) {
    const end = patch.indexOf("\n", start);
    if (end === -1) {
      yield patch.slice(start);
      return;
    }
    yield patch.slice(start, end);
    start = end + 1;
  }
}

function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "$"
  );
}

// An identifier-start char (letter, `_`, `$`); digits are excluded so a numeric constant or arithmetic operand
// (`2`, `1 + 2`) is never mistaken for a variable/expression operand in a concatenation.
function isIdentStart(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    ch === "_" ||
    ch === "$"
  );
}

// A sink and the kind of injection its dynamically-built first argument would carry.
type SinkKind = UnsafeExecFinding["kind"];

// Sinks whose FIRST argument is itself a shell/command string — interpolating into it is a command injection.
const SHELL_STRING_SINKS = new Set(["exec", "execSync"]);
// Sinks whose first argument is the command NAME (args go in a later array) — flag ONLY if the NAME is dynamic.
const COMMAND_NAME_SINKS = new Set([
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
]);
// Sinks that evaluate their first argument AS CODE — interpolating into it is a code injection.
const CODE_SINKS = new Set(["eval"]);
// Known `child_process` receiver names. A MEMBER command sink (`x.exec(...)`) is only a real shell call when `x`
// is one of these — `db.exec(...)`, `fs.execFile(...)`, etc. are NOT child_process and must not be flagged.
const CHILD_PROCESS_ALIASES = new Set([
  "cp",
  "childProcess",
  "child_process",
  "proc",
]);

// All command sinks share one kind; `eval`/`new Function` share the other.
function commandKind(): SinkKind {
  return "command-exec";
}
function codeKind(): SinkKind {
  return "code-eval";
}

// Extract a sink call's argument expressions: split at depth-0 commas from just after `(` to the matching close-
// paren. A single linear scan (deliberately NOT a regex) that respects quotes/backticks/escapes so a comma inside
// a string or a nested call does not terminate an argument, and bracket/brace/paren depth so nested structures are
// transparent. Returns null on a malformed/unterminated call (fail safe = caller skips the line). We need ALL args,
// not just the first, because `new Function(...params, body)` carries the executed code in its LAST argument.
function extractAllArgs(line: string, openParen: number): string[] | null {
  const n = line.length;
  let i = openParen + 1;
  let depth = 0; // depth of (), [], {} nested INSIDE an argument
  let quote = ""; // active string delimiter, or "" when outside a string
  let start = i;
  const args: string[] = [];
  while (i < n) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) {
        if (ch !== ")") return null; // a mismatched bracket closing the call → malformed
        args.push(line.slice(start, i));
        return args;
      }
      depth--;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      args.push(line.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  return null; // unterminated — fail safe
}

// Does the argument text build its value as a dynamic STRING? A single quote-aware scan so operators hidden inside
// string literals never count. Dynamic when a template literal (backtick) carries an interpolation `${`, OR when a
// `+` OUTSIDE any string concatenates AND a string/template literal is one of the operands. Requiring a string
// operand means pure arithmetic like `1 + 2` is NOT treated as command/code building (precision). A pure literal
// (`"ls -la"`, `"1+1"`) and a bare identifier (`cmd`) are likewise not dynamic. Bounded by the caller's line cap.
function isDynamicArg(arg: string): boolean {
  const n = arg.length;
  let i = 0;
  let quote = ""; // active string delimiter, or "" when outside a string
  let sawStringLiteral = false; // a "...", '...' or `...` literal appears in the argument
  let sawConcatOutside = false; // a `+` appears outside any string (a concatenation operator)
  let sawNonLiteralOutside = false; // an identifier/expression operand (a variable, member, or call) appears outside any string
  while (i < n) {
    const ch = arg[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      // A template-literal interpolation makes the value dynamic regardless of `+`.
      if (quote === "`" && ch === "$" && arg[i + 1] === "{") return true;
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      sawStringLiteral = true;
      quote = ch;
      i++;
      continue;
    }
    if (ch === "+") sawConcatOutside = true;
    if (isIdentStart(ch)) sawNonLiteralOutside = true;
    i++;
  }
  // Dynamic only when a string literal is concatenated with a NON-LITERAL operand (a variable, member, or call);
  // a literal-only concatenation such as `exec("git " + "status")` or `eval("1" + "+1")` builds a constant string,
  // so no interpolated or variable-controlled value reaches the sink and it must not be flagged.
  return sawConcatOutside && sawStringLiteral && sawNonLiteralOutside;
}

// At index `i` (start of an identifier; caller confirmed a word boundary precedes it), identify a dangerous sink
// whose argument makes it injectable, or null. Member calls are handled precisely: a member command sink is a real
// `child_process` call only when the receiver is a known alias; member `eval`/`Function` are never the globals.
function matchSinkAt(
  line: string,
  i: number,
): { sink: string; kind: SinkKind; argOpen: number } | null {
  const n = line.length;
  let j = i;
  while (j < n && isWordChar(line[j]!)) j++;
  const word = line.slice(i, j);
  if (!word) return null;

  let k = j;
  while (k < n && (line[k] === " " || line[k] === "\t")) k++;
  if (line[k] !== "(") return null;
  const argOpen = k;

  // Is this `receiver.word(...)` (a member call)? If so, capture the receiver identifier.
  let p = i - 1;
  while (p >= 0 && (line[p] === " " || line[p] === "\t")) p--;
  const isMember = p >= 0 && line[p] === ".";
  let receiver = "";
  if (isMember) {
    let r = p - 1;
    while (r >= 0 && (line[r] === " " || line[r] === "\t")) r--;
    const rEnd = r + 1;
    while (r >= 0 && isWordChar(line[r]!)) r--;
    receiver = line.slice(r + 1, rEnd);
  }

  let kind: SinkKind | null = null;
  let bodyIsLastArg = false;
  if (SHELL_STRING_SINKS.has(word) || COMMAND_NAME_SINKS.has(word)) {
    // A member command sink is only child_process when the receiver is a known alias (so `db.exec("SELECT …")`,
    // `fs.execFile(…)` etc. are NOT flagged); a bare `exec(…)`/`execSync(…)` (destructured import) is taken as-is.
    if (isMember && !CHILD_PROCESS_ALIASES.has(receiver)) return null;
    kind = commandKind();
  } else if (CODE_SINKS.has(word)) {
    if (isMember) return null; // `x.eval(…)` is not the global eval
    kind = codeKind();
  } else if (word === "Function") {
    // `Function(…)` and `new Function(…)` both construct a function from a code string (the LAST argument); a
    // member `x.Function(…)` is not the global constructor.
    if (isMember) return null;
    kind = codeKind();
    bodyIsLastArg = true;
  } else {
    return null;
  }

  const args = extractAllArgs(line, argOpen);
  if (args === null || args.length === 0) return null; // fail safe on malformed args
  // `Function(...paramNames, body)` evaluates its LAST argument as code; every other sink's injectable input is its
  // FIRST argument (the shell string, the command name, or the eval source).
  const argToCheck = bodyIsLastArg ? args[args.length - 1]! : args[0]!;
  if (!isDynamicArg(argToCheck)) return null; // literal / bare identifier / arithmetic → not flagged
  return { sink: word, kind, argOpen };
}

/** Scan ONE line for dangerous sink calls, threading block-comment state across lines. `startInComment` = this
 *  line begins inside an unclosed `/* ... *␊/` block comment. Returns the sinks found (never any while inside a
 *  string OR a block comment) plus whether the line ENDS still inside an open block comment, so the caller can
 *  carry that state to the next line — this is what makes a MULTI-LINE comment containing a sink fail safe. */
function scanLineForSinks(
  line: string,
  startInComment: boolean,
): { sinks: Array<{ sink: string; kind: SinkKind }>; endInComment: boolean } {
  const found: Array<{ sink: string; kind: SinkKind }> = [];
  const n = line.length;
  if (n > MAX_LINE_CHARS) return { sinks: found, endInComment: startInComment };
  let i = 0;
  let quote = ""; // active string delimiter, or "" when outside a string
  let inBlock = startInComment;
  while (i < n) {
    const c = line[i]!;
    if (inBlock) {
      // Inside a block comment nothing is code until the closing `*/`.
      if (c === "*" && line[i + 1] === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // Inside a string literal, sink-looking text (`const d = "execSync(`...`)"`, docs/examples) is NOT a real call.
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = "";
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      i++;
      continue;
    }
    // A line comment — the rest of the line is not code and cannot open a block comment.
    if (c === "/" && line[i + 1] === "/") return { sinks: found, endInComment: false };
    // A block comment opens here (it may or may not close on this line — `inBlock` carries the state forward).
    if (c === "/" && line[i + 1] === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      c === "_" ||
      c === "$"
    ) {
      // Word boundary: the char before must not be a word char (a leading `.` for `cp.execSync(...)` is fine).
      const prev = i === 0 ? "" : line[i - 1]!;
      if (!prev || !isWordChar(prev)) {
        const match = matchSinkAt(line, i);
        if (match) {
          found.push({ sink: match.sink, kind: match.kind });
          // Continue scanning AFTER this identifier so a second sink on the same line is still seen.
          let j = i;
          while (j < n && isWordChar(line[j]!)) j++;
          i = j;
          continue;
        }
      }
    }
    i++;
  }
  return { sinks: found, endInComment: inBlock };
}

/** Scan ONE standalone line of code for dangerous dynamic-execution sink calls (no surrounding comment state). */
export function extractUnsafeExecSinks(
  line: string,
): Array<{ sink: string; kind: SinkKind }> {
  return scanLineForSinks(line, false).sinks;
}

/** Scan one file patch's added lines for unsafe dynamic-execution sinks, line-cited via hunk headers. Pure. */
export function scanPatchForUnsafeExec(
  path: string,
  patch: string,
  limits: UnsafeExecScanLimits = {},
): UnsafeExecFinding[] {
  const maxFindings = limits.maxFindings ?? MAX_FINDINGS;
  if (maxFindings <= 0) return [];
  const findings: UnsafeExecFinding[] = [];
  let newLine = 0;
  let inComment = false; // carried across consecutive lines so a MULTI-LINE block comment is fully skipped
  for (const line of patchLines(patch)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      inComment = false; // a new hunk is non-contiguous source — do not carry comment state across the gap
      continue;
    }
    if (line.startsWith("+")) {
      const code = line.slice(1);
      const lead = code.trimStart();
      // Heuristic for a block comment whose OPENER sits outside the diff (e.g. a JSDoc body line): treat a leading
      // line comment, block-comment open, or a JSDoc continuation (`* `, a lone `*`, or a closing `*/`) as comment.
      // Narrowed to those `*` forms so it does not suppress real code such as `*ptr` or a multiplication. The
      // cross-line state below handles openers that ARE in the diff (a multi-line `/* ... sink ... */` added block).
      const leadComment =
        lead.startsWith("//") ||
        lead.startsWith("/*") ||
        lead.startsWith("* ") ||
        lead.startsWith("*/") ||
        lead === "*";
      const { sinks, endInComment } = scanLineForSinks(code, inComment);
      inComment = endInComment;
      if (!leadComment) {
        for (const sink of sinks) {
          findings.push({
            file: path,
            line: newLine,
            sink: sink.sink,
            kind: sink.kind,
          });
          if (findings.length >= maxFindings) return findings;
        }
      }
      newLine++;
    } else if (!line.startsWith("-")) {
      // Context (unchanged) line: not scanned for sinks, but it can open/close a block comment that affects the
      // next added line, so thread the comment state through it. Strip the leading marker ONLY when it is a real
      // unified-diff context space — otherwise (e.g. a line that itself starts with `/*`) pass it verbatim so the
      // comment scan sees the exact source and the `/*` is not corrupted into `*`.
      const contextCode = line.startsWith(" ") ? line.slice(1) : line;
      inComment = scanLineForSinks(contextCode, inComment).endInComment;
      newLine++;
    }
  }
  return findings;
}

/** Analyzer entrypoint: scan every changed file's added lines for unsafe dynamic-execution sinks. */
export async function scanUnsafeExec(
  req: EnrichRequest,
): Promise<UnsafeExecFinding[]> {
  const findings: UnsafeExecFinding[] = [];
  for (const file of req.files ?? []) {
    if (!file.patch) continue;
    for (const finding of scanPatchForUnsafeExec(file.path, file.patch, {
      maxFindings: MAX_FINDINGS - findings.length,
    })) {
      findings.push(finding);
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
