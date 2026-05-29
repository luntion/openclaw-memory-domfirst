import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmNode, GmEdge, RecallResult } from "../types.ts";
import { getCommunitySummary, getEpisodicMessages } from "../store/store.ts";

const CHARS_PER_TOKEN = 3;

export function buildSystemPromptAddition(params: {
  selectedNodes: Array<{ type: string; src: "active" | "recalled" }>;
  edgeCount: number;
  hasTimeline?: boolean;
  hasTimelineSummary?: boolean;
}): string {
  const { selectedNodes, edgeCount, hasTimeline, hasTimelineSummary } = params;
  if (selectedNodes.length === 0 && !hasTimeline) return "";

  const recalledCount = selectedNodes.filter((node) => node.src === "recalled").length;
  const hasRecalled = recalledCount > 0;
  const skillCount = selectedNodes.filter((node) => node.type === "SKILL").length;
  const eventCount = selectedNodes.filter((node) => node.type === "EVENT").length;
  const taskCount = selectedNodes.filter((node) => node.type === "TASK").length;
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3 || hasTimeline;

  const sections: string[] = [];
  sections.push(
    "## Graph Memory",
    "",
    "Below is structured long-term memory retrieved for the current turn.",
    "It is not raw chat history. It contains graph memory, episodic traces, and temporal timelines when available.",
    "",
    `Current memory view: ${skillCount} skills, ${eventCount} events, ${taskCount} tasks, ${edgeCount} relationships.`,
  );

  if (hasRecalled) {
    sections.push(
      "",
      `**${recalledCount} nodes recalled from other conversations**`,
      "Reuse them directly when the current situation matches their trigger conditions.",
    );
  }

  if (hasTimeline) {
    sections.push(
      "",
      "**Temporal memory is present**",
      "When a skill or fact changed over time, prefer the latest state unless the user explicitly asks for earlier versions or evolution details.",
    );
  }

  sections.push(
    "",
    "## Retrieved context",
    "",
    "- `<temporal_memory>`: ordered version timelines for changing facts and skills.",
    "- `<temporal_summary>`: a short natural-language summary of how something changed over time.",
    "- `<episodic_context>`: short source conversation traces tied to recalled nodes.",
    "- `<knowledge_graph>`: relevant TASK / SKILL / EVENT nodes and edges.",
    "",
    "Read this context first. Use memory tools only if the retrieved context is insufficient.",
  );

    if (isRich) {
    sections.push(
      "",
      "## Graph navigation hints",
      "- `SOLVED_BY`: an event was fixed by a skill",
      "- `USED_SKILL`: a task reused a skill",
      "- `PATCHES`: a newer skill corrected an older one",
      "- `CONFLICTS_WITH`: two skills should not be applied together without checking conditions",
    );
  }

  return sections.join("\n");
}

export function assembleContext(
  db: DatabaseSyncInstance,
  params: {
    tokenBudget: number;
    activeNodes: GmNode[];
    activeEdges: GmEdge[];
    recalledNodes: GmNode[];
    recalledEdges: GmEdge[];
    timeline?: RecallResult["timeline"];
    timelineSummary?: string;
  },
): { xml: string | null; systemPrompt: string; tokens: number; episodicXml: string; episodicTokens: number; temporalXml: string } {
  const map = new Map<string, GmNode & { src: "active" | "recalled" }>();
  for (const node of params.recalledNodes) map.set(node.id, { ...node, src: "recalled" });
  for (const node of params.activeNodes) map.set(node.id, { ...node, src: "active" });

  const typePriority: Record<string, number> = { SKILL: 3, TASK: 2, EVENT: 1 };
  const selected = Array.from(map.values())
    .filter((node) => node.status === "active")
    .sort(
      (a, b) =>
        (a.src === b.src ? 0 : a.src === "active" ? -1 : 1) ||
        (typePriority[b.type] ?? 0) - (typePriority[a.type] ?? 0) ||
        b.validatedCount - a.validatedCount ||
        b.pagerank - a.pagerank,
    );

  const temporalXml = buildTemporalXml(params.timeline, params.timelineSummary);
  if (!selected.length && !temporalXml) {
    return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0, temporalXml: "" };
  }

  const idToName = new Map<string, string>();
  for (const node of selected) idToName.set(node.id, node.name);

  const selectedIds = new Set(selected.map((node) => node.id));
  const allEdges = [...params.activeEdges, ...params.recalledEdges];
  const seenEdges = new Set<string>();
  const edges = allEdges.filter((edge) =>
    selectedIds.has(edge.fromId) &&
    selectedIds.has(edge.toId) &&
    !seenEdges.has(edge.id) &&
    seenEdges.add(edge.id),
  );

  const byCommunity = new Map<string, typeof selected>();
  const noCommunity: typeof selected = [];
  for (const node of selected) {
    if (node.communityId) {
      if (!byCommunity.has(node.communityId)) byCommunity.set(node.communityId, []);
      byCommunity.get(node.communityId)!.push(node);
    } else {
      noCommunity.push(node);
    }
  }

  const xmlParts: string[] = [];
  for (const [communityId, members] of byCommunity) {
    const summary = getCommunitySummary(db, communityId);
    const label = summary ? escapeXml(summary.summary) : communityId;
    xmlParts.push(`  <community id="${communityId}" desc="${label}">`);
    for (const node of members) {
      const tag = node.type.toLowerCase();
      const srcAttr = node.src === "recalled" ? ` source="recalled"` : "";
      const timeAttr = ` updated="${new Date(node.updatedAt).toISOString().slice(0, 10)}"`;
      xmlParts.push(`    <${tag} name="${node.name}" desc="${escapeXml(node.description)}"${srcAttr}${timeAttr}>`);
      xmlParts.push(node.content.trim());
      xmlParts.push(`    </${tag}>`);
    }
    xmlParts.push("  </community>");
  }

  for (const node of noCommunity) {
    const tag = node.type.toLowerCase();
    const srcAttr = node.src === "recalled" ? ` source="recalled"` : "";
    const timeAttr = ` updated="${new Date(node.updatedAt).toISOString().slice(0, 10)}"`;
    xmlParts.push(`  <${tag} name="${node.name}" desc="${escapeXml(node.description)}"${srcAttr}${timeAttr}>`);
    xmlParts.push(node.content.trim());
    xmlParts.push(`  </${tag}>`);
  }

  const nodesXml = xmlParts.join("\n");
  const edgesXml = edges.length
    ? `\n  <edges>\n${edges.map((edge) => {
        const fromName = idToName.get(edge.fromId) ?? edge.fromId;
        const toName = idToName.get(edge.toId) ?? edge.toId;
        const cond = edge.condition ? ` when="${escapeXml(edge.condition)}"` : "";
        return `    <e type="${edge.type}" from="${fromName}" to="${toName}"${cond}>${escapeXml(edge.instruction)}</e>`;
      }).join("\n")}\n  </edges>`
    : "";

  const graphXml = selected.length ? `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>` : "";
  const xml = [temporalXml, graphXml].filter(Boolean).join("\n\n");

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: selected.map((node) => ({ type: node.type, src: node.src })),
    edgeCount: edges.length,
    hasTimeline: Boolean(temporalXml),
    hasTimelineSummary: Boolean(params.timelineSummary),
  });

  const topNodes = selected.slice(0, 3);
  const episodicParts: string[] = [];
  for (const node of topNodes) {
    if (!node.sourceSessions?.length) continue;
    const recentSessions = node.sourceSessions.slice(-2);
    const messages = getEpisodicMessages(db, recentSessions, node.updatedAt, 500);
    if (!messages.length) continue;
    const lines = messages.map((message) =>
      `    [${message.role.toUpperCase()}] ${escapeXml(message.text.slice(0, 200))}`,
    ).join("\n");
    episodicParts.push(`  <trace node="${node.name}">\n${lines}\n  </trace>`);
  }

  const episodicXml = episodicParts.length
    ? `<episodic_context>\n${episodicParts.join("\n")}\n</episodic_context>`
    : "";

  const fullContent = systemPrompt + "\n\n" + xml + (episodicXml ? "\n\n" + episodicXml : "");
  return {
    xml,
    systemPrompt,
    tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN),
    episodicXml,
    episodicTokens: Math.ceil(episodicXml.length / CHARS_PER_TOKEN),
    temporalXml,
  };
}

function buildTemporalXml(timeline?: RecallResult["timeline"], timelineSummary?: string): string {
  if (!timeline?.length && !timelineSummary) return "";

  const summaryBlock = timelineSummary
    ? `<temporal_summary>\n${escapeXml(timelineSummary)}\n</temporal_summary>`
    : "";

  const blocks = (timeline ?? [])
    .filter((item) => item.versions.length)
    .map((item) => {
      const versions = item.versions.map((version) => {
        const captured = new Date(version.capturedAt).toISOString();
        const label = version.timelineLabel ? ` label="${escapeXml(version.timelineLabel)}"` : "";
        return [
          `    <version no="${version.versionNo}" captured="${captured}"${label}>`,
          `      <description>${escapeXml(version.description)}</description>`,
          `      <content>${escapeXml(version.content)}</content>`,
          "    </version>",
        ].join("\n");
      }).join("\n");
      return `  <timeline name="${escapeXml(item.name)}">\n${versions}\n  </timeline>`;
    });

  const memoryBlock = blocks.length
    ? `<temporal_memory>\n${blocks.join("\n")}\n</temporal_memory>`
    : "";
  return [summaryBlock, memoryBlock].filter(Boolean).join("\n\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
