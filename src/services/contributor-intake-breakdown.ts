import { sanitizePublicComment } from "../github/commands";
import type { ContributorIntakeHealth } from "../signals/engine";

// ─── Contributor intake breakdown (explanation family) ───────────────────────────────────────────
// A pure projection over a computed {@link ContributorIntakeHealth} that decomposes its otherwise-opaque
// intake `score` into the weighted deductions that lowered it from a perfect 100, and names the single
// highest-leverage lever a maintainer can pull to make the repo more attractive to contributors. Sibling of
// `queue-burden-breakdown.ts` and `score-breakdown.ts`: deterministic, no I/O, no GitHub fetch. Public-safe by
// construction — it reports the same observable drivers the intake summary already prints (queue burden out of
// 100, duplicate-cluster count, config band) and routes every rendered string through `sanitizePublicComment`.

export type IntakeDeductionBand = "none" | "low" | "moderate" | "high";

export type IntakeDeduction = {
  /** The intake factor this deduction comes from. */
  component: "queueBurden" | "duplicateClusters" | "configQuality";
  /** Observable driver behind the deduction (a queue-burden reading, a cluster count, or a config band). */
  driver: string;
  /** Points removed from the base 100 by this factor (always >= 0). */
  deduction: number;
  /** Share of the total deduction (0–100). */
  sharePercent: number;
  band: IntakeDeductionBand;
  summary: string;
  lever: string;
  /** 0–100 ranking weight used to pick the single highest-leverage improvement lever. */
  leverageScore: number;
};

export type ContributorIntakeBreakdown = {
  repoFullName: string;
  generatedAt: string;
  /** The authoritative (already clamped) intake score carried on the ContributorIntakeHealth. */
  score: number;
  level: ContributorIntakeHealth["level"];
  /** The perfect score every repo starts from before deductions. */
  baseScore: number;
  /** Sum of every factor's deduction (may exceed 100 before the engine floors the score at 0). */
  totalDeduction: number;
  /** True when the deductions exceeded the base 100 and the engine floored the score at 0. */
  clamped: boolean;
  components: IntakeDeduction[];
  highestLeverageLever: { component: string; lever: string; reason: string };
  summary: string;
};

const BASE_SCORE = 100;

// These weights MIRROR buildContributorIntakeHealth() in src/signals/engine.ts:
//   score = clamp(100 - burdenScore*0.55 - duplicateClusters*8 - configPenalty, 0, 100)
// A drift-guard test rebuilds a ContributorIntakeHealth through that function and asserts this module recomposes
// the same score, so an engine weight change fails the suite instead of silently producing a wrong breakdown.
const QUEUE_BURDEN_WEIGHT = 0.55;
const DUPLICATE_CLUSTER_WEIGHT = 8;

// The config-quality band maps to a fixed penalty (an excellent/unknown band costs nothing).
function configPenaltyFor(level: ContributorIntakeHealth["configLevel"]): number {
  if (level === "fragile") return 30;
  if (level === "needs_attention") return 18;
  if (level === "good") return 6;
  return 0;
}

function bandFor(deduction: number, sharePercent: number): IntakeDeductionBand {
  if (deduction <= 0) return "none";
  if (sharePercent >= 40) return "high";
  if (sharePercent >= 15) return "moderate";
  return "low";
}

function shareOf(deduction: number, totalDeduction: number): number {
  if (totalDeduction <= 0) return 0;
  return Math.round((deduction / totalDeduction) * 100);
}

function pickHighestLeverage(components: IntakeDeduction[]): ContributorIntakeBreakdown["highestLeverageLever"] {
  // Rank by share of the total deduction; break ties toward the larger raw deduction, then by name for
  // determinism. When nothing is deducted (a perfect intake), return an explicit no-op lever rather than an
  // arbitrary component, so the breakdown stays honest for a healthy repo.
  const ranked = [...components].sort(
    (left, right) =>
      right.leverageScore - left.leverageScore ||
      right.deduction - left.deduction ||
      left.component.localeCompare(right.component),
  );
  const top = ranked[0]!;
  if (top.leverageScore <= 0) {
    return {
      component: "none",
      lever: sanitizePublicComment("No intake lever needs attention; nothing is currently lowering the intake score."),
      reason: sanitizePublicComment("Contributor intake is at full strength, so there is no pressing lever to pull."),
    };
  }
  const reason =
    top.band === "high"
      ? `${top.component} is the dominant drag on contributor intake right now.`
      : `${top.component} is the largest remaining drag on contributor intake.`;
  return {
    component: top.component,
    lever: top.lever,
    reason: sanitizePublicComment(reason),
  };
}

/**
 * Pure projection over a {@link ContributorIntakeHealth} that explains how the intake `score` breaks down into
 * the weighted deductions that lowered it and names the single highest-leverage lever to improve intake.
 */
export function explainContributorIntake(health: ContributorIntakeHealth): ContributorIntakeBreakdown {
  const burdenDeduction = health.queueHealth.burdenScore * QUEUE_BURDEN_WEIGHT;
  const clusterDeduction = health.duplicateClusters * DUPLICATE_CLUSTER_WEIGHT;
  const configDeduction = configPenaltyFor(health.configLevel);
  const totalDeduction = burdenDeduction + clusterDeduction + configDeduction;

  const raw: Array<Pick<IntakeDeduction, "component" | "driver" | "deduction" | "summary" | "lever">> = [
    {
      component: "queueBurden",
      driver: `queue burden ${health.queueHealth.burdenScore}/100`,
      deduction: burdenDeduction,
      summary:
        burdenDeduction > 0
          ? `Queue burden of ${health.queueHealth.burdenScore}/100 is the review-load drag on intake.`
          : "Queue burden is zero, so it is not dragging on intake.",
      lever:
        burdenDeduction > 0
          ? "Bring the queue burden down (land or link open PRs, clear stale and aged work) to lift intake."
          : "Keep the queue clear so review load never drags on intake.",
    },
    {
      component: "duplicateClusters",
      driver: `${health.duplicateClusters} duplicate cluster(s)`,
      deduction: clusterDeduction,
      summary:
        clusterDeduction > 0
          ? `${health.duplicateClusters} duplicate or overlapping work cluster(s) are discouraging clean contributions.`
          : "No duplicate or overlapping work clusters are dragging on intake.",
      lever:
        clusterDeduction > 0
          ? "Resolve overlapping submissions so contributors are not competing on the same work."
          : "Keep deduplicating incoming work so collisions never drag on intake.",
    },
    {
      component: "configQuality",
      driver: `config ${health.configLevel}`,
      deduction: configDeduction,
      summary:
        configDeduction > 0
          ? `Repository config quality is ${health.configLevel}, which lowers how confidently contributors can engage.`
          : `Repository config quality is ${health.configLevel}, so it is not dragging on intake.`,
      lever:
        configDeduction > 0
          ? "Fix the flagged registry and label config issues to raise config quality and intake."
          : "Keep the registry and label config healthy so config quality never drags on intake.",
    },
  ];

  const components: IntakeDeduction[] = raw.map((entry) => {
    const sharePercent = shareOf(entry.deduction, totalDeduction);
    return {
      component: entry.component,
      driver: entry.driver,
      deduction: entry.deduction,
      sharePercent,
      band: bandFor(entry.deduction, sharePercent),
      summary: sanitizePublicComment(entry.summary),
      lever: sanitizePublicComment(entry.lever),
      leverageScore: sharePercent,
    };
  });

  const clamped = totalDeduction > BASE_SCORE;
  const highestLeverageLever = pickHighestLeverage(components);
  const summary =
    highestLeverageLever.component === "none"
      ? `Contributor intake is ${health.level} with nothing lowering the score.`
      : `Contributor intake is ${health.level}; ${highestLeverageLever.component} is the leading drag to address.`;

  return {
    repoFullName: health.repoFullName,
    generatedAt: health.generatedAt,
    score: health.score,
    level: health.level,
    baseScore: BASE_SCORE,
    totalDeduction,
    clamped,
    components,
    highestLeverageLever,
    summary: sanitizePublicComment(summary),
  };
}
