import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { EmbedFn } from "../engine/embed.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type {
  GmConfig,
  GmNode,
  RecallPlan,
  ScopeContext,
  ScopeFilter,
} from "../types.ts";
import { Extractor } from "../extractor/extract.ts";
import { getUnextracted, markExtracted, saveMessage, edgesFrom, edgesTo, getMessages } from "../store/store.ts";
import { assembleContext } from "../format/assemble.ts";
import { runMaintenance } from "../graph/maintenance.ts";
import { planRecall } from "./recall-plan.ts";
import { DomFirstRecaller } from "./recaller.ts";
import { defaultMetadata, buildScopeFilters } from "./scope.ts";
import {
  findScopedNodeByName,
  getScopedSessionNodes,
  getScopedStats,
  inspectScopedMemoryByName,
  listScopedPromotionCandidates,
  upsertScopedEdge,
  upsertScopedNode,
} from "./store.ts";
import { discoverKnowledgeFiles, indexKnowledgeFiles } from "./files.ts";
import { markPromotionCandidate, maybePromoteToTeam } from "./promotion.ts";
import { classifyEdgeScope, classifyNodeScope, extractEventTime, scopeIdFor } from "./classify.ts";

export class DomFirstMemoryEngine {
  private extractor: Extractor;
  private recaller: DomFirstRecaller;
  private embedFn: EmbedFn | null = null;
  private msgSeq = new Map<string, number>();
  private extractChain = new Map<string, Promise<void>>();

  constructor(
    private db: DatabaseSyncInstance,
    private cfg: GmConfig,
    private llm: CompleteFn,
    private logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void; error?: (...args: any[]) => void },
  ) {
    this.extractor = new Extractor(cfg, llm);
    this.recaller = new DomFirstRecaller(db, cfg);
  }

  setEmbedFn(fn: EmbedFn | null): void {
    this.embedFn = fn;
    if (fn) this.recaller.setEmbedFn(fn);
  }

  buildScopeContext(input: Partial<ScopeContext>): ScopeContext {
    return {
      sessionId: input.sessionId ?? "session-default",
      agentId: input.agentId ?? this.cfg.defaultAgentId,
      projectId: input.projectId ?? this.cfg.defaultProjectId,
      teamId: input.teamId ?? this.cfg.teamId,
      userId: input.userId,
    };
  }

  ingestMessage(ctx: ScopeContext, message: any, isHeartbeat?: boolean): { ingested: boolean } {
    if (isHeartbeat) return { ingested: false };
    let seq = this.msgSeq.get(ctx.sessionId);
    if (seq === undefined) {
      const row = this.db.prepare("SELECT MAX(turn_index) as maxTurn FROM gm_messages WHERE session_id=?").get(ctx.sessionId) as any;
      seq = Number(row?.maxTurn) || 0;
    }
    seq += 1;
    this.msgSeq.set(ctx.sessionId, seq);
    saveMessage(this.db, ctx.sessionId, seq, message.role ?? "unknown", message);
    return { ingested: true };
  }

  async afterTurn(ctx: ScopeContext, newMessages: any[]): Promise<void> {
    if (!newMessages.length) return;
    const prev = this.extractChain.get(ctx.sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const msgs = getUnextracted(this.db, ctx.sessionId, 50);
      if (!msgs.length) return;
      const existing = getScopedSessionNodes(this.db, ctx.sessionId).map((node) => node.name);
      const result = await this.extractor.extract({ messages: msgs, existingNames: existing });
      const conversationText = msgs.map((msg: any) => this.contentToText(msg.content)).join("\n");

      const knownNodes = new Map<string, GmNode>();
      for (const candidate of result.nodes) {
        const scopeType = classifyNodeScope(ctx, candidate, conversationText);
        const scopeId = scopeIdFor(ctx, this.cfg.teamId, scopeType);
        const eventTime = extractEventTime(conversationText);
        const resolvedAt = /修复|fix|resolved|解决|处理好了/i.test(candidate.content) ? Date.now() : null;
        const { node } = upsertScopedNode(
          this.db,
          candidate,
          ctx,
          {
            ...defaultMetadata(ctx, scopeType),
            scopeId,
            visibility: scopeType === "project" ? "shared" : "private",
            eventTime,
            resolvedAt,
          },
        );
        knownNodes.set(node.name, node);
        if (candidate.type !== "TASK" && (node.validatedCount >= 1 || /修复|fix|解决|error|故障/i.test(candidate.content))) {
          markPromotionCandidate(this.db, node.id);
          const refreshed = findScopedNodeByName(this.db, node.name, [{ scopeType: node.scopeType, scopeIds: [node.scopeId] }]);
          if (refreshed) {
            maybePromoteToTeam(this.db, refreshed, ctx, "double verification or explicit candidate");
          }
        }
      }

      for (const edge of result.edges) {
        const from = knownNodes.get(edge.from) ?? findScopedNodeByName(this.db, edge.from, buildScopeFilters(ctx, true));
        const to = knownNodes.get(edge.to) ?? findScopedNodeByName(this.db, edge.to, buildScopeFilters(ctx, true));
        if (!from || !to) continue;
        const scopeType = classifyEdgeScope(ctx, from, to);
        upsertScopedEdge(
          this.db,
          {
            fromId: from.id,
            toId: to.id,
            type: edge.type,
            instruction: edge.instruction,
            condition: edge.condition,
          },
          ctx,
          {
            ...defaultMetadata(ctx, scopeType),
            scopeId: scopeIdFor(ctx, this.cfg.teamId, scopeType),
            visibility: scopeType === "project" ? "shared" : "private",
          },
        );
      }

      const maxTurn = Math.max(...msgs.map((msg: any) => msg.turn_index));
      markExtracted(this.db, ctx.sessionId, maxTurn);
      this.logger?.info?.(`[openclaw-memory-domfirst] extracted ${result.nodes.length} nodes and ${result.edges.length} edges`);
    }).catch((error) => {
      this.logger?.error?.(`[openclaw-memory-domfirst] afterTurn extract failed: ${error}`);
    });
    this.extractChain.set(ctx.sessionId, next);
    await next;
  }

  planRecall(query: string, ctx: ScopeContext): RecallPlan {
    return planRecall(query, ctx);
  }

  async search(query: string, ctx: ScopeContext, overridePlan?: Partial<RecallPlan>) {
    const plan = { ...this.planRecall(query, ctx), ...overridePlan } as RecallPlan;
    const result = await this.recaller.recall(query, plan);
    return { plan, result };
  }

  async assemble(params: {
    ctx: ScopeContext;
    messages: any[];
    prompt?: string;
  }): Promise<{ messages: any[]; estimatedTokens: number; systemPromptAddition?: string; recallPlan: RecallPlan }> {
    const query = params.prompt?.trim() || this.lastUserText(params.messages) || "";
    const recallPlan = this.planRecall(query, params.ctx);
    const recalled = await this.recaller.recall(query, recallPlan);
    const activeNodes = getScopedSessionNodes(this.db, params.ctx.sessionId, [{ scopeType: "session", scopeIds: [params.ctx.sessionId] }]);
    const activeEdges = activeNodes.flatMap((node) => [...edgesFrom(this.db, node.id), ...edgesTo(this.db, node.id)]);
    const recallForContext =
      recallPlan.depth === "L1"
        ? { ...recalled, nodes: recalled.nodes.slice(0, 3), edges: [] }
        : recallPlan.depth === "L2"
          ? { ...recalled, nodes: recalled.nodes.slice(0, 5), edges: recalled.edges.slice(0, 5) }
          : recalled;

    const { xml, systemPrompt, tokens, episodicXml, temporalXml } = assembleContext(this.db, {
      tokenBudget: 0,
      activeNodes,
      activeEdges,
      recalledNodes: recallForContext.nodes,
      recalledEdges: recallForContext.edges,
      timeline: recallForContext.timeline,
      timelineSummary: recallForContext.timelineSummary,
    });

    const systemPromptAddition = [systemPrompt, temporalXml, xml, episodicXml].filter(Boolean).join("\n\n") || undefined;
    return {
      messages: this.keepRecentMessages(params.messages),
      estimatedTokens: tokens,
      systemPromptAddition,
      recallPlan,
    };
  }

  stats(ctx: ScopeContext) {
    return getScopedStats(this.db, buildScopeFilters(ctx, true));
  }

  inspect(name: string, ctx: ScopeContext, includeTeam = true) {
    const filters = buildScopeFilters(ctx, includeTeam);
    return inspectScopedMemoryByName(this.db, name, filters);
  }

  candidates(ctx: ScopeContext, includeTeam = true, limit = 20) {
    const filters = buildScopeFilters(ctx, includeTeam);
    return listScopedPromotionCandidates(this.db, filters, limit);
  }

  async runMaintenance(): Promise<any> {
    return runMaintenance(this.db, this.cfg, this.llm, this.embedFn ?? undefined);
  }

  promote(name: string, ctx: ScopeContext, explicit = false) {
    const node = findScopedNodeByName(this.db, name, buildScopeFilters(ctx, false));
    if (!node) {
      return { promoted: false, reason: "node not found" };
    }
    if (explicit) {
      this.db.prepare(`
        UPDATE gm_nodes
        SET promotion_state='candidate',
            verification_count = MAX(verification_count, 2),
            confidence = MAX(confidence, 0.95),
            updated_at = ?
        WHERE id = ?
      `).run(Date.now(), node.id);
    } else {
      markPromotionCandidate(this.db, node.id);
    }
    const refreshed = findScopedNodeByName(this.db, name, buildScopeFilters(ctx, false));
    if (!refreshed) return { promoted: false, reason: "node disappeared" };
    return maybePromoteToTeam(this.db, refreshed, ctx, explicit ? "explicit promotion" : "verified candidate");
  }

  reindex(root: string, ctx: ScopeContext) {
    const files = discoverKnowledgeFiles(root, this.cfg.knowledgeMarkers);
    return indexKnowledgeFiles(this.db, files, ctx);
  }

  disposeSession(sessionId: string): void {
    this.extractChain.delete(sessionId);
    this.msgSeq.delete(sessionId);
  }

  getRecentMessages(sessionId: string, limit = 10): any[] {
    return getMessages(this.db, sessionId, limit);
  }

  private keepRecentMessages(messages: any[]): any[] {
    return messages.slice(-12);
  }

  private lastUserText(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .filter((block: any) => block?.type === "text" && typeof block.text === "string")
          .map((block: any) => block.text)
          .join("\n");
      }
      return String(message.content ?? "");
    }
    return "";
  }

  private contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block: any) => {
          if (typeof block?.text === "string") return block.text;
          return "";
        })
        .join("\n");
    }
    return String(content ?? "");
  }

}
