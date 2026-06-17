import { describe, expect, it } from "vitest";
import { parseCodeowners } from "../../src/github/codeowners";
import { buildReviewerRouting, REVIEWER_BUSY_OPEN_PR_THRESHOLD } from "../../src/signals/reviewer-routing";
import type { BurdenForecast } from "../../src/signals/engine";
import type { PullRequestRecord } from "../../src/types";

function openPr(authorLogin: string, number: number): PullRequestRecord {
  return { repoFullName: "acme/widget", number, title: `PR ${number}`, state: "open", authorLogin, labels: [], linkedIssues: [] };
}

describe("buildReviewerRouting", () => {
  it("ranks suggestions by matched-file count (descending)", () => {
    const rules = parseCodeowners(["/src/api/   @api-owner", "/src/web/   @web-owner"].join("\n"));
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["src/api/a.ts", "src/api/b.ts", "src/web/c.ts"],
      openPullRequests: [],
    });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["api-owner", "web-owner"]);
    expect(routing.suggestions[0]).toMatchObject({ login: "api-owner", matchedFileCount: 2 });
    expect(routing.suggestions[1]).toMatchObject({ login: "web-owner", matchedFileCount: 1 });
  });

  it("derives the load band from authored open PRs; a busy owner ranks below a light owner at equal match count", () => {
    const rules = parseCodeowners(["/a/   @busy", "/b/   @light"].join("\n"));
    // `busy` authors >= threshold open PRs, `light` authors fewer.
    const openPullRequests = [
      ...Array.from({ length: REVIEWER_BUSY_OPEN_PR_THRESHOLD }, (_, i) => openPr("busy", 100 + i)),
      openPr("light", 1),
    ];
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["a/x.ts", "b/y.ts"], // each owns exactly one changed file
      openPullRequests,
    });
    expect(routing.suggestions.map((s) => [s.login, s.loadBand])).toEqual([
      ["light", "light"],
      ["busy", "busy"],
    ]);
  });

  it("never suggests the PR author as their own reviewer (author exclusion)", () => {
    const rules = parseCodeowners(["/src/   @maintainer", "/src/own.ts   @self"].join("\n"));
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["src/own.ts"],
      openPullRequests: [],
      authorLogin: "self", // matches the last-match-wins owner of src/own.ts
    });
    expect(routing.suggestions.map((s) => s.login)).not.toContain("self");
    expect(routing.suggestions).toHaveLength(0);
  });

  it("excludes the author case-insensitively and with a leading @", () => {
    const rules = parseCodeowners("*  @Alice @bob");
    const routing = buildReviewerRouting({ rules, changedPaths: ["x.ts"], openPullRequests: [], authorLogin: "@alice" });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["bob"]);
  });

  it("collects @org/team handles separately from individual reviewers", () => {
    const rules = parseCodeowners("/src/  @org/platform-team @alice");
    const routing = buildReviewerRouting({ rules, changedPaths: ["src/x.ts"], openPullRequests: [] });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["alice"]);
    expect(routing.teams).toEqual(["org/platform-team"]);
  });

  it("skips email owners (cannot be routed to)", () => {
    const rules = parseCodeowners("/src/  dev@example.com @alice");
    const routing = buildReviewerRouting({ rules, changedPaths: ["src/x.ts"], openPullRequests: [] });
    expect(routing.suggestions.map((s) => s.login)).toEqual(["alice"]);
    expect(routing.teams).toEqual([]);
  });

  it("returns empty suggestions when there are no CODEOWNERS rules", () => {
    const routing = buildReviewerRouting({ rules: [], changedPaths: ["src/x.ts"], openPullRequests: [] });
    expect(routing.suggestions).toEqual([]);
    expect(routing.teams).toEqual([]);
    expect(routing.summary).toMatch(/no codeowners reviewers/i);
  });

  it("carries the repo load level from the burden forecast as overall context", () => {
    const rules = parseCodeowners("/src/  @alice");
    const forecast = { level: "high" } as BurdenForecast;
    const routing = buildReviewerRouting({ rules, changedPaths: ["src/x.ts"], openPullRequests: [], burdenForecast: forecast });
    expect(routing.repoLoadLevel).toBe("high");
    const none = buildReviewerRouting({ rules, changedPaths: ["src/x.ts"], openPullRequests: [], burdenForecast: null });
    expect(none.repoLoadLevel).toBeNull();
  });

  it("caps the number of suggestions and de-duplicates owners across files", () => {
    const owners = Array.from({ length: 8 }, (_, i) => `@owner${i}`);
    // Each owner owns one distinct path; expect the output capped to 5.
    const rules = parseCodeowners(owners.map((o, i) => `/p${i}/  ${o}`).join("\n"));
    const changedPaths = owners.flatMap((_, i) => [`p${i}/a.ts`, `p${i}/b.ts`]); // 2 files each → de-dupe to count 2
    const routing = buildReviewerRouting({ rules, changedPaths, openPullRequests: [] });
    expect(routing.suggestions).toHaveLength(5);
    // Each suggested owner owns 2 files (de-duped per file, counted once per distinct path).
    for (const s of routing.suggestions) expect(s.matchedFileCount).toBe(2);
  });

  it("is public-safe: the output exposes NO trust/credibility/reward/score fields for any reviewer", () => {
    const rules = parseCodeowners("/src/  @alice @org/team");
    const routing = buildReviewerRouting({
      rules,
      changedPaths: ["src/x.ts"],
      openPullRequests: [openPr("alice", 1)],
      burdenForecast: { level: "low" } as BurdenForecast,
    });
    const forbidden = ["trust", "credibility", "reward", "score", "rank", "weight"];
    for (const suggestion of routing.suggestions) {
      // The suggestion shape is exactly {login, matchedFileCount, loadBand, reason}.
      expect(Object.keys(suggestion).sort()).toEqual(["loadBand", "login", "matchedFileCount", "reason"]);
      const serialized = JSON.stringify(suggestion).toLowerCase();
      for (const term of forbidden) expect(serialized).not.toContain(term);
    }
  });
});
