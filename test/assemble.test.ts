import { describe, it, expect, beforeEach } from "vitest";
import { type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode } from "./helpers.ts";
import { assembleContext, buildSystemPromptAddition } from "../src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "../src/format/transcript-repair.ts";
import { findById } from "../src/store/store.ts";
import type { GmNode } from "../src/types.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

describe("buildSystemPromptAddition", () => {
  it("returns empty string when no nodes and no timeline exist", () => {
    const result = buildSystemPromptAddition({ selectedNodes: [], edgeCount: 0 });
    expect(result).toBe("");
  });

  it("returns graph-memory guidance when nodes exist", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "EVENT", src: "recalled" },
      ],
      edgeCount: 2,
    });

    expect(result).toContain("Graph Memory");
    expect(result).toContain("1 nodes recalled from other conversations");
  });

  it("mentions temporal memory when timeline exists", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [],
      edgeCount: 0,
      hasTimeline: true,
    });

    expect(result).toContain("Temporal memory is present");
  });
});

describe("assembleContext", () => {
  it("builds knowledge_graph xml when nodes exist", () => {
    const id = insertNode(db, { name: "test-skill", type: "SKILL", content: "## test\nsome content" });
    const node = findById(db, id)!;

    const { xml, systemPrompt, tokens } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [node],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toContain("<knowledge_graph>");
    expect(xml).toContain('name="test-skill"');
    expect(xml).toContain("</knowledge_graph>");
    expect(systemPrompt).toContain("Graph Memory");
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns null xml when no nodes and no timeline exist", () => {
    const { xml, systemPrompt } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toBeNull();
    expect(systemPrompt).toBe("");
  });

  it("marks recalled nodes with source=recalled", () => {
    const id = insertNode(db, { name: "recalled-skill", type: "SKILL" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [],
      activeEdges: [],
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain('source="recalled"');
  });

  it("includes temporal_memory when a timeline is provided", () => {
    const id = insertNode(db, { name: "timeline-skill", type: "SKILL", content: "current approach" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [],
      activeEdges: [],
      recalledNodes: [node],
      recalledEdges: [],
      timeline: [
        {
          name: "timeline-skill",
          versions: [
            {
              id: `${id}#v1`,
              nodeId: id,
              versionNo: 1,
              content: "initial approach",
              description: "v1",
              capturedAt: Date.now() - 1000,
              supersededAt: Date.now(),
              timelineLabel: "initial",
            },
          ],
        },
      ],
      timelineSummary: "timeline-skill: v1 -> current",
    });

    expect(xml).toContain("<temporal_memory>");
    expect(xml).toContain("<temporal_summary>");
    expect(xml).toContain('timeline name="timeline-skill"');
    expect(xml).toContain("initial approach");
  });

  it("does not truncate nodes just because tokenBudget is small", () => {
    const nodes: GmNode[] = [];
    for (let i = 0; i < 20; i++) {
      const id = insertNode(db, {
        name: `skill-${i}`,
        content: "x".repeat(5000),
      });
      nodes.push(findById(db, id)!);
    }

    const { xml } = assembleContext(db, {
      tokenBudget: 1000,
      activeNodes: nodes,
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    const matches = xml?.match(/name="skill-/g) ?? [];
    expect(matches.length).toBe(20);
  });
});

describe("sanitizeToolUseResultPairing", () => {
  it("keeps valid tool_use/toolResult pairs intact", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    ];

    const result = sanitizeToolUseResultPairing(messages);
    expect(result).toHaveLength(3);
  });

  it("inserts missing toolResult placeholders", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "user", content: "next" },
    ];

    const result = sanitizeToolUseResultPairing(messages);
    const toolResults = result.filter((message) => message.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("drops orphaned toolResult messages", () => {
    const messages = [
      { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "lost" }] },
      { role: "user", content: "hello" },
    ];

    const result = sanitizeToolUseResultPairing(messages);
    expect(result.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("keeps the first valid toolResult when duplicates exist", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "duplicate" }] },
      { role: "assistant", content: "next response" },
    ];

    const result = sanitizeToolUseResultPairing(messages);
    expect(result.filter((message) => message.role === "assistant")).toHaveLength(2);
    const toolResults = result.filter((message) => message.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect((toolResults[0].content[0] as any).text).toBe("first");
  });
});
