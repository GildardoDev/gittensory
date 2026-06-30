// Units for the unsafe-dynamic-execution analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. Runs against the compiled dist/. Verifies the conservative flag condition (dynamic first arg
// into a dangerous sink), correct line numbers via hunk headers, MAX_FINDINGS bounding, and that neither the
// finding nor the rendered brief ever leaks the argument value.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanUnsafeExec,
  scanPatchForUnsafeExec,
  extractUnsafeExecSinks,
} from "../dist/analyzers/unsafe-exec.js";
import { renderBrief } from "../dist/render.js";

// Build a +-prefixed unified-diff patch that adds the given lines starting at new-file line `start`.
const addedPatch = (addedLines, start = 10) => {
  const body = addedLines.map((l) => `+${l}`).join("\n");
  return `@@ -1,0 +${start},${addedLines.length} @@\n${body}`;
};

// ── FLAGGED cases ────────────────────────────────────────────────────────────

test("flags execSync with a template-interpolated command (command-exec)", () => {
  const findings = scanPatchForUnsafeExec(
    "src/run.ts",
    addedPatch(["execSync(`git clone ${repo}`)"], 10),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    file: "src/run.ts",
    line: 10,
    sink: "execSync",
    kind: "command-exec",
  });
});

test("flags exec with string concatenation (command-exec)", () => {
  const findings = scanPatchForUnsafeExec(
    "src/run.ts",
    addedPatch(['exec("rm " + path)'], 5),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sink, "exec");
  assert.equal(findings[0].kind, "command-exec");
  assert.equal(findings[0].line, 5);
});

test("flags eval with an interpolated expression (code-eval)", () => {
  const findings = scanPatchForUnsafeExec(
    "src/run.ts",
    addedPatch(["eval(`(${expr})`)"], 3),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sink, "eval");
  assert.equal(findings[0].kind, "code-eval");
});

test("flags new Function with a concatenated body (code-eval)", () => {
  const findings = scanPatchForUnsafeExec(
    "src/run.ts",
    addedPatch(['new Function("return " + body)'], 7),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sink, "Function");
  assert.equal(findings[0].kind, "code-eval");
});

test("flags new Function MULTI-arg form where the dynamic body is the LAST argument (code-eval)", () => {
  // The code is the final argument; earlier args are parameter names. The first arg is a literal, so a first-arg-
  // only check would miss this — the analyzer must inspect the body (last) argument.
  const findings = scanPatchForUnsafeExec(
    "src/run.ts",
    addedPatch(['const f = new Function("x", "y", "return " + body)'], 12),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sink, "Function");
  assert.equal(findings[0].kind, "code-eval");
});

test("does NOT flag pure arithmetic in a sink arg (no string operand)", () => {
  // `1 + 2` is arithmetic, not command/code string building — the `+` must not classify it as dynamic.
  assert.equal(extractUnsafeExecSinks("exec(1 + 2)").length, 0);
  assert.equal(extractUnsafeExecSinks("eval(a + b)").length, 0);
  // new Function whose body is a pure literal is also safe.
  assert.equal(extractUnsafeExecSinks('new Function("x", "return x")').length, 0);
});

test("does NOT flag a LITERAL-ONLY string concatenation (no variable reaches the sink)", () => {
  // `"git " + "status"` and `"1" + "+1"` concatenate two string literals into a constant; no interpolated or
  // variable-controlled value reaches the sink, so the near-zero-FP contract requires they are not flagged.
  assert.equal(extractUnsafeExecSinks('exec("git " + "status")').length, 0);
  assert.equal(extractUnsafeExecSinks('eval("1" + "+1")').length, 0);
  assert.equal(extractUnsafeExecSinks('execSync("ls " + "-la" + " /tmp")').length, 0);
  // A string literal joined to a numeric constant is still a constant, not a variable operand.
  assert.equal(extractUnsafeExecSinks('exec("port " + 8080)').length, 0);
  // But a string literal concatenated with a real identifier/expression IS dynamic and must still be flagged.
  assert.equal(extractUnsafeExecSinks('exec("git " + cmd)').length, 1);
  assert.equal(extractUnsafeExecSinks('exec("rm " + process.argv[2])').length, 1);
});

test("does NOT flag a non-child_process member sink (db.exec, fs.execFile, obj.eval)", () => {
  // The classic false positive: a database `.exec` / `.query` is not a shell call.
  assert.equal(extractUnsafeExecSinks('db.exec("SELECT * FROM t WHERE id = " + id)').length, 0);
  assert.equal(extractUnsafeExecSinks("fs.execFile(`${bin}`, args)").length, 0);
  assert.equal(extractUnsafeExecSinks("obj.eval(`${expr}`)").length, 0); // member eval is not the global eval
});

test("flags a known child_process member alias and a bare Function() call (no new)", () => {
  assert.equal(extractUnsafeExecSinks("cp.execSync(`git ${repo}`)").length, 1);
  assert.equal(extractUnsafeExecSinks('childProcess.exec("rm " + p)').length, 1);
  // `Function(...)` is the same constructor as `new Function(...)`; the body (last arg) is what is evaluated.
  const f = extractUnsafeExecSinks('const g = Function("a", "return " + body)');
  assert.equal(f.length, 1);
  assert.equal(f[0].sink, "Function");
  assert.equal(f[0].kind, "code-eval");
});

test("flags a member-call sink like cp.execSync(`...${x}`)", () => {
  const sinks = extractUnsafeExecSinks("cp.execSync(`echo ${value}`)");
  assert.deepEqual(sinks, [{ sink: "execSync", kind: "command-exec" }]);
});

test("flags spawn ONLY when the command NAME is dynamically built", () => {
  // Dynamic command name → flagged.
  assert.deepEqual(extractUnsafeExecSinks("spawn(`${bin}`, [])"), [
    { sink: "spawn", kind: "command-exec" },
  ]);
  assert.deepEqual(extractUnsafeExecSinks('spawn("git-" + sub, [])'), [
    { sink: "spawn", kind: "command-exec" },
  ]);
});

test("tracks new-file line numbers across hunk headers and context lines", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+execSync(`ls ${dir}`)",
    " const b = 2;",
    "@@ -10,1 +20,2 @@",
    " const c = 3;",
    "+eval(`(${x})`)",
  ].join("\n");
  const findings = scanPatchForUnsafeExec("src/x.ts", patch);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].sink, "execSync");
  assert.equal(findings[1].line, 21);
  assert.equal(findings[1].sink, "eval");
});

test("scanUnsafeExec spans multiple files", async () => {
  const findings = await scanUnsafeExec({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1,
    files: [
      { path: "a.ts", patch: addedPatch(["exec(`a ${x}`)"], 1) },
      { path: "b.ts", patch: addedPatch(["eval(`(${y})`)"], 1) },
      { path: "c.ts", patch: "" },
    ],
  });
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((f) => f.file),
    ["a.ts", "b.ts"],
  );
});

test("bounds findings to MAX_FINDINGS (25)", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `exec(\`cmd ${"${" + "v" + i + "}"}\`)`);
  const findings = await scanUnsafeExec({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1,
    files: [{ path: "big.ts", patch: addedPatch(lines, 1) }],
  });
  assert.equal(findings.length, 25);
});

// ── NOT FLAGGED cases (precision) ────────────────────────────────────────────

test("does NOT flag a pure string-literal command", () => {
  assert.equal(extractUnsafeExecSinks('execSync("ls -la")').length, 0);
  assert.equal(extractUnsafeExecSinks('eval("1+1")').length, 0);
});

test("does NOT flag a commented-out sink (line comment or block-comment body)", () => {
  // Commented-out code is not executed, so an interpolated sink in a comment must not be a false positive.
  assert.deepEqual(scanPatchForUnsafeExec("f.ts", addedPatch(['// exec("rm " + path)'])), []);
  assert.deepEqual(
    scanPatchForUnsafeExec("f.ts", addedPatch([" * execSync(`git clone ${repo}`) — example in docs"])),
    [],
  );
});

test("does NOT flag a sink name inside a string literal or a trailing comment (the gate's false-positive class)", () => {
  // A sink name inside a string (docs string, example, error message) is not a call.
  assert.equal(extractUnsafeExecSinks('const docs = "execSync(`git clone ${repo}`)"').length, 0);
  assert.equal(extractUnsafeExecSinks("const help = 'run eval(' + name + ') manually'").length, 0);
  // A sink in a trailing line comment is not executed.
  assert.equal(extractUnsafeExecSinks('const x = compute(); // exec("rm " + path)').length, 0);
  // But a REAL sink that follows a string on the same line is still detected.
  assert.equal(extractUnsafeExecSinks('const note = "x"; execSync(`${cmd}`)').length, 1);
  // A sink inside a mid-line block comment is not executed; a real sink after the comment still is.
  assert.equal(extractUnsafeExecSinks('foo(); /* exec("rm " + p) */').length, 0);
  assert.equal(extractUnsafeExecSinks('/* note */ execSync(`${cmd}`)').length, 1);
});

test("CONTRACT (line-local): a sink inside a template ${...} interpolation is intentionally not reported", () => {
  // Documented scope: the scanner does NOT descend into `${...}`; a sink hidden there is a known, accepted miss
  // (favoring a simple linear pass + zero false positives over exhaustive recall).
  assert.equal(extractUnsafeExecSinks("const s = `${execSync(`cmd ${x}`)}`;").length, 0);
  // A sink-looking substring inside a template literal body is (still) never a false positive.
  assert.equal(extractUnsafeExecSinks("const msg = `run execSync(`...`) carefully`;").length, 0);
});

test("does NOT flag a sink inside a MULTI-LINE block comment, but does after it closes (cross-line state)", () => {
  // `/*` opens on one added line, the sink is on the NEXT, `*/` closes on a third — all inside the comment.
  assert.deepEqual(
    scanPatchForUnsafeExec("f.ts", addedPatch(["/* disabled for now:", "execSync(`cmd ${x}`)", "*/"])),
    [],
  );
  // a real sink on its own line after the block comment closes is still detected.
  assert.equal(
    scanPatchForUnsafeExec("f.ts", addedPatch(["/* note", "*/", "execSync(`${cmd}`)"])).length,
    1,
  );
});

test("tracks a block comment OPENED by a context line (no leading-marker corruption) so the added sink inside is not flagged", () => {
  // Gate's case: an unchanged context line opens `/*`, the added sink is inside it, a later context line closes `*/`.
  const spacePrefixed = ["@@ -1,3 +1,4 @@", " /* disabled:", "+execSync(`cmd ${x}`)", " */"].join("\n");
  assert.deepEqual(scanPatchForUnsafeExec("f.ts", spacePrefixed), []);
  // Robustness: a context line whose `/*` is at column 0 (no diff space) must still read as `/*`, not `*` — this is
  // the exact regression for the slice(1) fix (old code corrupted `/*`→`*`, missed the comment, and false-flagged).
  const noSpace = ["@@ -1,2 +1,3 @@", "/* opened at col 0", "+execSync(`cmd ${x}`)", "*/"].join("\n");
  assert.deepEqual(scanPatchForUnsafeExec("f.ts", noSpace), []);
});

test("does NOT flag spawn with a literal command + args array", () => {
  assert.equal(
    extractUnsafeExecSinks('spawn("git", ["status", branch])').length,
    0,
  );
  assert.equal(
    extractUnsafeExecSinks('execFile("ls", ["-la", dir])').length,
    0,
  );
});

test("does NOT flag a bare identifier argument", () => {
  assert.equal(extractUnsafeExecSinks("exec(cmd)").length, 0);
  assert.equal(extractUnsafeExecSinks("eval(code)").length, 0);
  assert.equal(extractUnsafeExecSinks("execSync(command)").length, 0);
});

test("does NOT flag a removed (-) line that matches", () => {
  const patch = [
    "@@ -1,2 +1,1 @@",
    "-execSync(`git clone ${repo}`)",
    " const keep = 1;",
  ].join("\n");
  assert.equal(scanPatchForUnsafeExec("src/x.ts", patch).length, 0);
});

test("flags bare Function(...) the same as new Function(...) (it is the same constructor)", () => {
  // `Function("return " + body)` constructs+evaluates code exactly like `new Function(...)`, so it IS a code sink.
  const f = extractUnsafeExecSinks('Function("return " + body)');
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "code-eval");
});

test("does NOT flag a sink-looking word inside a larger identifier", () => {
  assert.equal(extractUnsafeExecSinks("myexec(`${x}`)").length, 0);
  assert.equal(extractUnsafeExecSinks("preeval(`${x}`)").length, 0);
});

// ── render is public-safe ────────────────────────────────────────────────────

test("renderBrief surfaces file:line + sink + kind and NEVER the argument text", () => {
  const { promptSection } = renderBrief({
    unsafeExec: [
      { file: "src/run.ts", line: 12, sink: "execSync", kind: "command-exec" },
      { file: "src/run.ts", line: 30, sink: "eval", kind: "code-eval" },
    ],
  });
  assert.match(promptSection, /Unsafe dynamic execution/);
  assert.match(promptSection, /src\/run\.ts:12/);
  assert.match(promptSection, /execSync/);
  assert.match(promptSection, /shell command/);
  assert.match(promptSection, /src\/run\.ts:30/);
  assert.match(promptSection, /code/);
  // The argument value must never appear.
  assert.ok(!promptSection.includes("git clone"));
  assert.ok(!promptSection.includes("${"));
});
