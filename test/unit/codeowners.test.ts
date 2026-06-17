import { describe, expect, it } from "vitest";
import { matchCodeowners, parseCodeowners, type CodeownersRule } from "../../src/github/codeowners";

describe("parseCodeowners", () => {
  it("skips blank lines and # comments, keeps pattern + owners in file order", () => {
    const content = [
      "# This is a comment",
      "",
      "   # indented comment",
      "*       @global-owner",
      "/src    @core-team @second-owner",
      "  ", // whitespace-only line
      "docs/   @docs-owner",
    ].join("\n");
    const rules = parseCodeowners(content);
    expect(rules).toEqual<CodeownersRule[]>([
      { pattern: "*", owners: ["@global-owner"] },
      { pattern: "/src", owners: ["@core-team", "@second-owner"] },
      { pattern: "docs/", owners: ["@docs-owner"] },
    ]);
  });

  it("supports multiple owners, team handles, and email owners on one line", () => {
    const rules = parseCodeowners("/api  @org/api-team  @alice  dev@example.com");
    expect(rules).toEqual<CodeownersRule[]>([{ pattern: "/api", owners: ["@org/api-team", "@alice", "dev@example.com"] }]);
  });

  it("keeps a pattern with no owners (GitHub treats it as a matching rule with no owner)", () => {
    const rules = parseCodeowners("/vendor/");
    expect(rules).toEqual<CodeownersRule[]>([{ pattern: "/vendor/", owners: [] }]);
  });

  it("returns [] for empty / comment-only content", () => {
    expect(parseCodeowners("")).toEqual([]);
    expect(parseCodeowners("# only a comment\n\n")).toEqual([]);
  });
});

describe("matchCodeowners", () => {
  it("returns [] when no rule matches", () => {
    const rules = parseCodeowners("/src  @core");
    expect(matchCodeowners(rules, "docs/readme.md")).toEqual([]);
  });

  it("applies last-match-wins (the LAST matching rule's owners prevail)", () => {
    const rules = parseCodeowners(["*           @global", "/src        @src-team", "/src/api    @api-team"].join("\n"));
    expect(matchCodeowners(rules, "src/api/handler.ts")).toEqual(["@api-team"]);
    expect(matchCodeowners(rules, "src/util/x.ts")).toEqual(["@src-team"]);
    expect(matchCodeowners(rules, "package.json")).toEqual(["@global"]);
  });

  it("a leading slash anchors to the repo root (does NOT match a nested same-named dir)", () => {
    const rules = parseCodeowners("/build/  @builders");
    expect(matchCodeowners(rules, "build/output.js")).toEqual(["@builders"]);
    expect(matchCodeowners(rules, "packages/app/build/output.js")).toEqual([]);
  });

  it("a trailing slash matches everything under the directory prefix", () => {
    const rules = parseCodeowners("docs/  @docs-team");
    expect(matchCodeowners(rules, "docs/guide/intro.md")).toEqual(["@docs-team"]);
    expect(matchCodeowners(rules, "docs/index.md")).toEqual(["@docs-team"]);
    // A file literally named `docs` at root is not under the directory.
    expect(matchCodeowners(rules, "docs")).toEqual([]);
  });

  it("`*` matches within a path segment", () => {
    const rules = parseCodeowners("*.ts  @ts-owners");
    expect(matchCodeowners(rules, "index.ts")).toEqual(["@ts-owners"]);
    expect(matchCodeowners(rules, "src/index.ts")).toEqual(["@ts-owners"]); // bare pattern matches anywhere
    const anchored = parseCodeowners("/scripts/*.sh  @ops");
    expect(matchCodeowners(anchored, "scripts/deploy.sh")).toEqual(["@ops"]);
    // `*` does not cross a segment boundary.
    expect(matchCodeowners(anchored, "scripts/sub/deploy.sh")).toEqual([]);
  });

  it("`**` matches across path segments", () => {
    const rules = parseCodeowners("/apps/**/config.yml  @platform");
    expect(matchCodeowners(rules, "apps/web/config.yml")).toEqual(["@platform"]);
    expect(matchCodeowners(rules, "apps/web/nested/deep/config.yml")).toEqual(["@platform"]);
    expect(matchCodeowners(rules, "apps/config.yml")).toEqual(["@platform"]);
  });

  it("a bare pattern (no slash) matches anywhere in the tree", () => {
    const rules = parseCodeowners("Dockerfile  @infra");
    expect(matchCodeowners(rules, "Dockerfile")).toEqual(["@infra"]);
    expect(matchCodeowners(rules, "services/api/Dockerfile")).toEqual(["@infra"]);
  });

  it("returns the team handle as an owner of the last matching rule", () => {
    const rules = parseCodeowners("/api/  @org/api-team");
    expect(matchCodeowners(rules, "api/v1/users.ts")).toEqual(["@org/api-team"]);
  });
});
