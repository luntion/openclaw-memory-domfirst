import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "./helpers.ts";
import { planRecall } from "../src/domfirst/recall-plan.ts";
import { upsertScopedNode, findScopedNodeByName } from "../src/domfirst/store.ts";
import { maybePromoteToTeam, markPromotionCandidate } from "../src/domfirst/promotion.ts";
import { DomFirstRecaller } from "../src/domfirst/recaller.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { classifyNodeScope } from "../src/domfirst/classify.ts";
import { getNodeVersions } from "../src/store/store.ts";
import { DomFirstMemoryEngine } from "../src/domfirst/engine.ts";
import { createSQLiteRuntime } from "../src/backend/sqlite.ts";

let db: ReturnType<typeof createTestDb>;

const ctx = {
  sessionId: "sess-1",
  agentId: "agent-a",
  projectId: "proj-1",
  teamId: "team-1",
};

beforeEach(() => {
  db = createTestDb();
});

describe("recall planner", () => {
  it("uses L1 for confirmation queries", () => {
    const plan = planRecall("昨天那个 skill 我们遇到过故障对吧", ctx);
    expect(plan.depth).toBe("L1");
  });

  it("uses L3 for cause/process queries", () => {
    const plan = planRecall("昨天那个 skill 的故障是什么，最后怎么修复的", ctx);
    expect(plan.depth).toBe("L3");
  });

  it("adds a time range for yesterday queries", () => {
    const now = new Date("2026-05-29T10:00:00Z").getTime();
    const plan = planRecall("昨天那个 skill 的故障是什么", ctx, now);
    expect(plan.timeRange?.label).toBe("yesterday");
    expect(plan.preferRecent).toBe(true);
  });

  it("switches to past mode for before/previous phrasing", () => {
    const plan = planRecall("之前那个 skill 是怎么做的", ctx);
    expect(plan.temporalMode).toBe("past");
  });

  it("switches to evolution mode for change-over-time phrasing", () => {
    const plan = planRecall("那个 skill 后来是怎么改的", ctx);
    expect(plan.temporalMode).toBe("evolution");
  });
});

describe("scope isolation", () => {
  it("keeps same name isolated by scope", () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "shared-fix",
      description: "agent-a private fix",
      content: "agent-a content",
    }, ctx, { scopeType: "agent", scopeId: "agent-a" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "shared-fix",
      description: "agent-b private fix",
      content: "agent-b content",
    }, { ...ctx, agentId: "agent-b", sessionId: "sess-2" }, { scopeType: "agent", scopeId: "agent-b" });

    const a = findScopedNodeByName(db, "shared-fix", [{ scopeType: "agent", scopeIds: ["agent-a"] }]);
    const b = findScopedNodeByName(db, "shared-fix", [{ scopeType: "agent", scopeIds: ["agent-b"] }]);

    expect(a?.description).toContain("agent-a");
    expect(b?.description).toContain("agent-b");
  });
});

describe("project scope classification", () => {
  it("routes project-specific skills into the project scope", () => {
    const scope = classifyNodeScope(ctx, {
      type: "SKILL",
      name: "openclaw-memory-plugin-build",
      description: "Build the plugin in the project workspace",
      content: "Run npm build for the openclaw plugin module",
    }, "We were working on the project plugin build pipeline");

    expect(scope).toBe("project");
  });

  it("keeps generic skills in the agent scope", () => {
    const scope = classifyNodeScope(ctx, {
      type: "SKILL",
      name: "generic-terminal-reset",
      description: "A generic shell reset",
      content: "This is a generic reusable workflow",
    }, "This is a generic fix");

    expect(scope).toBe("agent");
  });
});

describe("promotion", () => {
  it("promotes verified candidates into the team scope", () => {
    const { node } = upsertScopedNode(db, {
      type: "SKILL",
      name: "docker-port-fix",
      description: "fix port collisions",
      content: "docker compose down && up",
    }, ctx, { scopeType: "agent", scopeId: "agent-a", confidence: 0.9, verificationCount: 2 });

    markPromotionCandidate(db, node.id);
    const refreshed = findScopedNodeByName(db, "docker-port-fix", [{ scopeType: "agent", scopeIds: ["agent-a"] }])!;
    const result = maybePromoteToTeam(db, refreshed, ctx, "test promotion");
    const teamNode = findScopedNodeByName(db, "docker-port-fix", [{ scopeType: "team", scopeIds: ["team-1"] }]);

    expect(result.promoted).toBe(true);
    expect(teamNode?.scopeType).toBe("team");
  });
});

describe("scoped recaller", () => {
  it("does not leak team nodes into agent-only plans", async () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "team-fix",
      description: "team scope",
      content: "shared remediation",
    }, ctx, { scopeType: "team", scopeId: "team-1", visibility: "shared", confidence: 0.95, verificationCount: 2, promotionState: "promoted" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "agent-fix",
      description: "agent scope",
      content: "private remediation",
    }, ctx, { scopeType: "agent", scopeId: "agent-a" });

    const recaller = new DomFirstRecaller(db, DEFAULT_CONFIG);
    const result = await recaller.recall("remediation", {
      depth: "L2",
      includeTeam: false,
      maxNodes: 5,
      maxDepth: 1,
      reason: "agent only",
      scopeFilters: [
        { scopeType: "agent", scopeIds: ["agent-a"] },
      ],
      temporalMode: "current",
    });

    expect(result.nodes.some((node) => node.scopeType === "team")).toBe(false);
  });

  it("filters yesterday recall results by time range", async () => {
    const now = new Date("2026-05-29T10:00:00Z").getTime();
    upsertScopedNode(db, {
      type: "EVENT",
      name: "yesterday-failure",
      description: "failure from yesterday",
      content: "plugin failure yesterday",
    }, ctx, {
      scopeType: "agent",
      scopeId: "agent-a",
      eventTime: new Date("2026-05-28T08:00:00Z").getTime(),
    });

    upsertScopedNode(db, {
      type: "EVENT",
      name: "last-week-failure",
      description: "older failure",
      content: "plugin failure older",
    }, ctx, {
      scopeType: "agent",
      scopeId: "agent-a",
      eventTime: new Date("2026-05-21T08:00:00Z").getTime(),
    });

    const recaller = new DomFirstRecaller(db, DEFAULT_CONFIG);
    const plan = planRecall("昨天那个 plugin 故障是什么", ctx, now);
    const result = await recaller.recall("plugin failure", plan);

    expect(result.nodes.some((node) => node.name === "yesterday-failure")).toBe(true);
    expect(result.nodes.some((node) => node.name === "last-week-failure")).toBe(false);
  });

  it("stores superseded versions when a node changes", () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "deploy-flow",
      description: "old deploy flow",
      content: "run npm build then deploy",
    }, ctx, {
      scopeType: "project",
      scopeId: "proj-1",
      eventTime: new Date("2026-05-28T09:00:00Z").getTime(),
    });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "deploy-flow",
      description: "new deploy flow",
      content: "run npm test, npm build, then deploy",
    }, ctx, {
      scopeType: "project",
      scopeId: "proj-1",
      eventTime: new Date("2026-05-29T09:00:00Z").getTime(),
      supersededBy: "deploy-flow-v2",
    });

    const versions = getNodeVersions(db, "deploy-flow", [{ scopeType: "project", scopeIds: ["proj-1"] }]);
    const rawCount = db.prepare("SELECT COUNT(*) as c FROM gm_node_versions").get() as any;
    expect(rawCount.c).toBeGreaterThanOrEqual(1);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0].content).toContain("run npm build then deploy");
  });

  it("returns historical versions in past mode", async () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "skill-history",
      description: "old version",
      content: "old fix path",
    }, ctx, { scopeType: "agent", scopeId: "agent-a" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "skill-history",
      description: "new version",
      content: "new fix path",
    }, ctx, {
      scopeType: "agent",
      scopeId: "agent-a",
      supersededBy: "skill-history-new",
    });

    const recaller = new DomFirstRecaller(db, DEFAULT_CONFIG);
    const result = await recaller.recall("skill-history", {
      depth: "L2",
      includeTeam: false,
      maxNodes: 5,
      maxDepth: 1,
      reason: "past recall",
      scopeFilters: [{ scopeType: "agent", scopeIds: ["agent-a"] }],
      temporalMode: "past",
    });

    expect(result.nodes.some((node) => node.content.includes("old fix path"))).toBe(true);
    expect(result.timeline?.[0]?.versions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns an ordered evolution timeline in evolution mode", async () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "timeline-skill",
      description: "v1",
      content: "initial approach",
    }, ctx, { scopeType: "project", scopeId: "proj-1" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "timeline-skill",
      description: "v2",
      content: "second approach",
    }, ctx, { scopeType: "project", scopeId: "proj-1", supersededBy: "timeline-skill-v2" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "timeline-skill",
      description: "v3",
      content: "current approach",
    }, ctx, { scopeType: "project", scopeId: "proj-1", supersededBy: "timeline-skill-v3" });

    const recaller = new DomFirstRecaller(db, DEFAULT_CONFIG);
    const result = await recaller.recall("timeline-skill", {
      depth: "L3",
      includeTeam: false,
      maxNodes: 8,
      maxDepth: 2,
      reason: "evolution recall",
      scopeFilters: [{ scopeType: "project", scopeIds: ["proj-1"] }],
      temporalMode: "evolution",
    });

    expect(result.timeline?.some((item) => item.name === "timeline-skill")).toBe(true);
    const chain = result.timeline?.find((item) => item.name === "timeline-skill");
    expect(chain?.versions[0]?.content).toContain("initial approach");
    expect(chain?.versions.some((version) => version.content.includes("second approach"))).toBe(true);
    expect(result.timelineSummary).toContain("timeline-skill:");
  });
});

describe("admin/debug memory access", () => {
  it("inspects current nodes and version history by name", async () => {
    upsertScopedNode(db, {
      type: "SKILL",
      name: "inspect-skill",
      description: "old state",
      content: "old content",
    }, ctx, { scopeType: "agent", scopeId: "agent-a" });

    upsertScopedNode(db, {
      type: "SKILL",
      name: "inspect-skill",
      description: "new state",
      content: "new content",
    }, ctx, { scopeType: "agent", scopeId: "agent-a", supersededBy: "inspect-skill-v2" });

    const engine = new DomFirstMemoryEngine(createSQLiteRuntime(db, DEFAULT_CONFIG), db, DEFAULT_CONFIG, async () => "");
    const result = await engine.inspect("inspect-skill", ctx, false);

    expect(result.nodes.length).toBeGreaterThanOrEqual(1);
    expect(result.nodes[0].content).toContain("new content");
    expect(result.versions.length).toBeGreaterThanOrEqual(1);
    expect(result.versions[0].content).toContain("old content");
  });

  it("lists promotion candidates in scoped memory", async () => {
    const { node } = upsertScopedNode(db, {
      type: "SKILL",
      name: "candidate-skill",
      description: "candidate",
      content: "candidate content",
    }, ctx, { scopeType: "agent", scopeId: "agent-a" });

    markPromotionCandidate(db, node.id);
    const engine = new DomFirstMemoryEngine(createSQLiteRuntime(db, DEFAULT_CONFIG), db, DEFAULT_CONFIG, async () => "");
    const items = await engine.candidates(ctx, false, 10);

    expect(items.some((item) => item.name === "candidate-skill")).toBe(true);
  });
});
