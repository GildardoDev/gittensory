import { describe, expect, it } from "vitest";
import { explainContributorIntake } from "../../src/services/contributor-intake-breakdown";
import { buildContributorIntakeHealth, type CollisionReport, type ContributorIntakeHealth } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const FORBIDDEN = /\b(wallet|hotkey|coldkey|mnemonic|payout|reward|raw[-_\s]?trust|credibility|farming)\b/i;

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

function makeIntake(input: {
  burdenScore?: number;
  duplicateClusters?: number;
  configLevel?: ContributorIntakeHealth["configLevel"];
  score?: number;
  level?: ContributorIntakeHealth["level"];
  repoFullName?: string;
  generatedAt?: string;
}): ContributorIntakeHealth {
  return {
    repoFullName: input.repoFullName ?? "owner/repo",
    generatedAt: input.generatedAt ?? "2026-07-01T00:00:00.000Z",
    level: input.level ?? "healthy",
    score: input.score ?? 100,
    queueHealth: {
      burdenScore: input.burdenScore ?? 0,
      level: "low",
      signals: {
        openIssues: 0,
        openPullRequests: 0,
        unlinkedPullRequests: 0,
        stalePullRequests: 0,
        draftPullRequests: 0,
        maintainerAuthoredPullRequests: 0,
        collisionClusters: 0,
        ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 },
        likelyReviewablePullRequests: 0,
      },
    },
    configLevel: input.configLevel ?? "excellent",
    duplicateClusters: input.duplicateClusters ?? 0,
    reviewablePullRequests: 0,
    summary: "fixture",
    findings: [],
  };
}

const componentByName = (breakdown: ReturnType<typeof explainContributorIntake>, name: string) =>
  breakdown.components.find((entry) => entry.component === name)!;

describe("contributor intake breakdown", () => {
  it("reports a perfect intake with no deductions and an honest no-op lever", () => {
    const breakdown = explainContributorIntake(makeIntake({ score: 100, level: "healthy" }));
    expect(breakdown.totalDeduction).toBe(0);
    expect(breakdown.clamped).toBe(false);
    expect(breakdown.components).toHaveLength(3);
    for (const entry of breakdown.components) {
      expect(entry.band).toBe("none");
      expect(entry.sharePercent).toBe(0);
      expect(entry.leverageScore).toBe(0);
    }
    expect(breakdown.highestLeverageLever.component).toBe("none");
    expect(breakdown.highestLeverageLever.reason).toMatch(/full strength/i);
    expect(breakdown.summary).toMatch(/nothing lowering/i);
  });

  it("flags a dominant queue-burden drag as high band and the top lever, with a small low-band factor", () => {
    // burden 100×0.55 = 55, config good = 6, clusters 0 → total 61. burden ≈90% (high), config ≈10% (low).
    const breakdown = explainContributorIntake(makeIntake({ burdenScore: 100, configLevel: "good", score: 39, level: "strained" }));
    const burden = componentByName(breakdown, "queueBurden");
    expect(burden.deduction).toBeCloseTo(55);
    expect(burden.sharePercent).toBe(90);
    expect(burden.band).toBe("high");
    expect(componentByName(breakdown, "duplicateClusters").band).toBe("none");
    expect(componentByName(breakdown, "configQuality").band).toBe("low");
    expect(breakdown.clamped).toBe(false);
    expect(breakdown.highestLeverageLever.component).toBe("queueBurden");
    expect(breakdown.highestLeverageLever.reason).toMatch(/dominant/i);
  });

  it("classifies a moderate top drag and names the largest-remaining lever", () => {
    // burden 15×0.55 = 8.25, clusters 1×8 = 8, config good = 6 → total 22.25; all shares in the moderate band.
    const breakdown = explainContributorIntake(makeIntake({ burdenScore: 15, duplicateClusters: 1, configLevel: "good", score: 78, level: "healthy" }));
    const burden = componentByName(breakdown, "queueBurden");
    expect(burden.band).toBe("moderate");
    expect(breakdown.highestLeverageLever.component).toBe("queueBurden");
    expect(breakdown.highestLeverageLever.reason).toMatch(/largest remaining/i);
  });

  it("decomposes each config band into its fixed penalty", () => {
    expect(componentByName(explainContributorIntake(makeIntake({ configLevel: "needs_attention" })), "configQuality").deduction).toBe(18);
    expect(componentByName(explainContributorIntake(makeIntake({ configLevel: "good" })), "configQuality").deduction).toBe(6);
    expect(componentByName(explainContributorIntake(makeIntake({ configLevel: "excellent" })), "configQuality").deduction).toBe(0);
  });

  it("marks the breakdown clamped when deductions exceed the base 100", () => {
    // burden 100×0.55 = 55, clusters 3×8 = 24, config fragile = 30 → 109 > 100, engine floors the score at 0.
    const breakdown = explainContributorIntake(makeIntake({ burdenScore: 100, duplicateClusters: 3, configLevel: "fragile", score: 0, level: "blocked" }));
    expect(breakdown.totalDeduction).toBeCloseTo(109);
    expect(breakdown.clamped).toBe(true);
    expect(componentByName(breakdown, "configQuality").deduction).toBe(30);
    expect(breakdown.score).toBe(0);
  });

  it("passes through repo identity, level, and generatedAt", () => {
    const breakdown = explainContributorIntake(
      makeIntake({ repoFullName: "acme/widgets", generatedAt: "2026-02-03T04:05:06.000Z", level: "watch", score: 60, burdenScore: 40 }),
    );
    expect(breakdown.repoFullName).toBe("acme/widgets");
    expect(breakdown.generatedAt).toBe("2026-02-03T04:05:06.000Z");
    expect(breakdown.level).toBe("watch");
    expect(breakdown.baseScore).toBe(100);
    expect(breakdown.summary).toMatch(/contributor intake is watch/i);
  });

  it("never leaks private or reward terminology in any rendered string", () => {
    const breakdown = explainContributorIntake(makeIntake({ burdenScore: 80, duplicateClusters: 2, configLevel: "needs_attention" }));
    for (const entry of breakdown.components) {
      expect(entry.summary).not.toMatch(FORBIDDEN);
      expect(entry.lever).not.toMatch(FORBIDDEN);
      expect(entry.driver).not.toMatch(FORBIDDEN);
    }
    expect(breakdown.highestLeverageLever.reason).not.toMatch(FORBIDDEN);
    expect(breakdown.summary).not.toMatch(FORBIDDEN);
  });

  it("recomposes the exact intake score the engine computes (weight drift guard)", () => {
    const repo = { fullName: "owner/repo", isRegistered: true } as unknown as RepositoryRecord;
    const pullRequests: PullRequestRecord[] = [
      { repoFullName: "owner/repo", number: 1, title: "aged unlinked", state: "open", labels: [], linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z" },
      { repoFullName: "owner/repo", number: 2, title: "aged unlinked two", state: "open", labels: [], linkedIssues: [], updatedAt: "2020-01-01T00:00:00.000Z" },
    ];
    const issues = [{ repoFullName: "owner/repo", number: 10, title: "open issue", state: "open", labels: [], linkedPrs: [], body: null }];
    const collisions = { repoFullName: "owner/repo", summary: { clusterCount: 2, highRiskCount: 0 } } as unknown as CollisionReport;

    const built = buildContributorIntakeHealth(repo, issues, pullRequests, "owner/repo", collisions);
    const breakdown = explainContributorIntake(built);

    // Reconstructing 100 minus the decomposed deductions (using this module's weights) must equal the engine score.
    expect(clamp(breakdown.baseScore - breakdown.totalDeduction)).toBeCloseTo(built.score, 6);
    expect(componentByName(breakdown, "duplicateClusters").deduction).toBe(16);
    expect(componentByName(breakdown, "queueBurden").deduction).toBeCloseTo(built.queueHealth.burdenScore * 0.55, 6);
  });
});
