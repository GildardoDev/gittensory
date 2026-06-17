import { matchCodeowners, type CodeownersRule } from "../github/codeowners";
import type { PullRequestRecord } from "../types";
import type { BurdenForecast } from "./engine";

/**
 * Open-PR count at/above which a CODEOWNERS owner is treated as "busy" rather than "light". There is no
 * requested-reviewer data available, so the only load proxy is how many OPEN PRs the owner currently
 * AUTHORS. Three concurrent open PRs is a deliberately conservative line: below it an owner is a
 * "light" suggestion, at/above it they are de-weighted to "busy". Advisory only — never a hard exclusion.
 */
export const REVIEWER_BUSY_OPEN_PR_THRESHOLD = 3;

/** Maximum number of individual reviewer suggestions surfaced; keeps the advisory panel section short. */
export const MAX_REVIEWER_SUGGESTIONS = 5;

/** Load band derived from an owner's current authored-open-PR count. Never a score; a coarse bucket. */
export type ReviewerLoadBand = "light" | "busy";

export type ReviewerSuggestion = {
  /** A bare GitHub login (leading `@` stripped). Public repo metadata — never carries any trust/score. */
  login: string;
  /** How many of this PR's changed files this owner owns via CODEOWNERS. The primary ranking key. */
  matchedFileCount: number;
  /** Coarse current-load bucket from authored open PRs. De-weights a busy owner at equal match count. */
  loadBand: ReviewerLoadBand;
  /** Public-safe, human-readable one-liner explaining why this owner was suggested. */
  reason: string;
};

export type ReviewerRouting = {
  /** Individual `@user` owners, ranked and capped. Public-safe; no trust/credibility/reward fields. */
  suggestions: ReviewerSuggestion[];
  /** `@org/team` handles matched by CODEOWNERS, collected separately (teams are not load-ranked). */
  teams: string[];
  /** Overall repo review-load context from the burden forecast, when one is available; else null. */
  repoLoadLevel: BurdenForecast["level"] | null;
  /** A public-safe one-line summary of the routing result for the panel header. */
  summary: string;
};

export type ReviewerRoutingInput = {
  rules: CodeownersRule[];
  changedPaths: string[];
  openPullRequests: PullRequestRecord[];
  authorLogin?: string | null | undefined;
  burdenForecast?: BurdenForecast | null | undefined;
};

/** Strip a single leading `@` from a CODEOWNERS owner handle; everything else is left intact. */
function stripLeadingAt(owner: string): string {
  return owner.startsWith("@") ? owner.slice(1) : owner;
}

/** A team owner is `@org/team` — it has a slash once the leading `@` is gone. Emails contain `@` mid-string. */
function isTeamOwner(owner: string): boolean {
  if (!owner.startsWith("@")) return false; // emails / bare names are never teams
  return stripLeadingAt(owner).includes("/");
}

/** An individual reviewer owner is an `@user` handle (leading `@`, no slash, not an email). */
function isUserOwner(owner: string): boolean {
  return owner.startsWith("@") && !stripLeadingAt(owner).includes("/");
}

/**
 * Build advisory reviewer-routing suggestions from a repo's CODEOWNERS and a PR's changed files. PURE.
 *
 * For each changed path the LAST matching CODEOWNERS rule's owners are collected (GitHub semantics). Each
 * individual `@user` owner is counted by how many changed files they own; `@org/team` handles are collected
 * separately (teams are not load-ranked). The PR author is never suggested as their own reviewer. Each
 * remaining owner's load band comes from how many OPEN PRs they currently author (the only available load
 * proxy — there is no requested-reviewer data). Suggestions are ranked by matched-file count (desc), then
 * by load band (light before busy), then by login (asc), and capped at {@link MAX_REVIEWER_SUGGESTIONS}.
 *
 * Output is strictly public-safe: it carries logins (public repo metadata), file counts, a coarse load
 * band, and a reason string — and deliberately NO trust/credibility/reward/score fields for any reviewer.
 */
export function buildReviewerRouting(input: ReviewerRoutingInput): ReviewerRouting {
  const authorLogin = input.authorLogin ? stripLeadingAt(input.authorLogin).toLowerCase() : null;

  // Count matched changed files per individual owner login, and collect teams separately.
  const matchedFileCountByLogin = new Map<string, number>();
  const teamSet = new Set<string>();
  for (const path of input.changedPaths) {
    const owners = matchCodeowners(input.rules, path);
    // De-dupe within a single file so an owner listed twice on one rule does not double-count.
    const seenForPath = new Set<string>();
    for (const owner of owners) {
      if (isTeamOwner(owner)) {
        teamSet.add(stripLeadingAt(owner));
        continue;
      }
      if (!isUserOwner(owner)) continue; // skip emails / bare names — we cannot route to them
      const login = stripLeadingAt(owner);
      const key = login.toLowerCase();
      if (key === authorLogin) continue; // never suggest the PR author as their own reviewer
      if (seenForPath.has(key)) continue;
      seenForPath.add(key);
      matchedFileCountByLogin.set(login, (matchedFileCountByLogin.get(login) ?? 0) + 1);
    }
  }

  // Per-owner load band from authored OPEN PRs (the only available proxy; there is no reviewer-request data).
  const openPrCountByLogin = new Map<string, number>();
  for (const pr of input.openPullRequests) {
    if (pr.state !== "open") continue;
    const login = pr.authorLogin ? stripLeadingAt(pr.authorLogin).toLowerCase() : null;
    if (!login) continue;
    openPrCountByLogin.set(login, (openPrCountByLogin.get(login) ?? 0) + 1);
  }

  const suggestions: ReviewerSuggestion[] = Array.from(matchedFileCountByLogin.entries()).map(([login, matchedFileCount]) => {
    const openPrCount = openPrCountByLogin.get(login.toLowerCase()) ?? 0;
    const loadBand: ReviewerLoadBand = openPrCount >= REVIEWER_BUSY_OPEN_PR_THRESHOLD ? "busy" : "light";
    const fileWord = matchedFileCount === 1 ? "file" : "files";
    const reason =
      loadBand === "busy"
        ? `Owns ${matchedFileCount} changed ${fileWord}; currently has several open PRs.`
        : `Owns ${matchedFileCount} changed ${fileWord}.`;
    return { login, matchedFileCount, loadBand, reason };
  });

  suggestions.sort((a, b) => {
    if (b.matchedFileCount !== a.matchedFileCount) return b.matchedFileCount - a.matchedFileCount;
    if (a.loadBand !== b.loadBand) return a.loadBand === "light" ? -1 : 1; // light before busy
    return a.login.localeCompare(b.login);
  });

  const capped = suggestions.slice(0, MAX_REVIEWER_SUGGESTIONS);
  const teams = Array.from(teamSet).sort((a, b) => a.localeCompare(b));
  const repoLoadLevel = input.burdenForecast?.level ?? null;

  const summary =
    capped.length === 0 && teams.length === 0
      ? "No CODEOWNERS reviewers matched the changed files."
      : capped.length > 0
        ? `Suggested ${capped.length} reviewer${capped.length === 1 ? "" : "s"} from CODEOWNERS for the changed files (advisory).`
        : `Matched ${teams.length} CODEOWNERS team${teams.length === 1 ? "" : "s"} for the changed files (advisory).`;

  return { suggestions: capped, teams, repoLoadLevel, summary };
}
