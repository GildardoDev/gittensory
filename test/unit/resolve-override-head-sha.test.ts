import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOverrideHeadSha } from "../../src/queue/processors";
import { createInstallationToken } from "../../src/github/app";
import type { PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// resolveOverrideHeadSha re-fetches the live head via createInstallationToken + REST /pulls/{n}; mock the token
// mint (the test env holds no App key) and stub fetch per case.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  createInstallationToken: vi.fn(),
}));
const mockedToken = vi.mocked(createInstallationToken);

function makePr(headSha: string | null): PullRequestRecord {
  return { repoFullName: "owner/repo", number: 90, title: "Override me", state: "open", labels: [], linkedIssues: [], headSha };
}

function stubLiveHead(sha: string | null): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/pulls/90")) return new Response(JSON.stringify(sha === null ? {} : { head: { sha } }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

describe("resolveOverrideHeadSha (#16 / gate-override stale head)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the cached head when the live head matches", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveHead("cached-sha");
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("cached-sha"))).toEqual({ headSha: "cached-sha", stale: false, liveHeadSha: "cached-sha" });
    expect(mockedToken).toHaveBeenCalledWith(env, 123);
  });

  it("does not mark stale when the cached head is absent (null), even if a live head exists", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveHead("live-sha");
    // pr.headSha is null → the `pr.headSha` arm short-circuits; there is nothing the maintainer approved to neutralize.
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr(null))).toEqual({ headSha: null, stale: false, liveHeadSha: "live-sha" });
  });

  it("marks the command stale when the live head differs from the cached head", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-tok" });
    mockedToken.mockRejectedValue(new Error("no app key"));
    stubLiveHead("live-sha");
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toEqual({ headSha: "stale-sha", stale: true, liveHeadSha: "live-sha" });
  });

  it("fails OPEN to the cached head when the live fetch is unreadable", async () => {
    const env = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-tok" });
    mockedToken.mockResolvedValue("inst-tok");
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toEqual({ headSha: "stale-sha", stale: false, liveHeadSha: undefined });
  });

  it("returns the cached head when the live payload omits head.sha (fail-open)", async () => {
    const env = createTestEnv();
    mockedToken.mockResolvedValue("inst-tok");
    stubLiveHead(null);
    expect(await resolveOverrideHeadSha(env, 123, "owner/repo", makePr("stale-sha"))).toEqual({ headSha: "stale-sha", stale: false, liveHeadSha: undefined });
  });
});
