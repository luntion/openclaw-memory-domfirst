import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmNode, ScopeContext } from "../types.ts";
import { defaultMetadata } from "./scope.ts";
import { findScopedNodeByName, upsertScopedNode } from "./store.ts";

export interface PromotionResult {
  promoted: boolean;
  source?: string;
  targetScope?: string;
  reason: string;
}

export function markPromotionCandidate(db: DatabaseSyncInstance, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET promotion_state='candidate', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId);
}

export function maybePromoteToTeam(
  db: DatabaseSyncInstance,
  node: GmNode,
  ctx: ScopeContext,
  reason: string,
): PromotionResult {
  const eligible =
    node.promotionState === "candidate" &&
    (node.verificationCount >= 2 || node.validatedCount >= 2 || node.confidence >= 0.85);

  if (!eligible) {
    return { promoted: false, reason: "double verification threshold not met" };
  }

  const existing = findScopedNodeByName(db, node.name, [{ scopeType: "team", scopeIds: [ctx.teamId ?? "team-default"] }]);
  if (existing) {
    db.prepare(`
      UPDATE gm_nodes
      SET verification_count = verification_count + 1,
          confidence = MAX(confidence, ?),
          promotion_state = 'promoted',
          updated_at = ?
      WHERE id = ?
    `).run(node.confidence, Date.now(), existing.id);
    return { promoted: true, source: node.id, targetScope: existing.scopeId, reason };
  }

  upsertScopedNode(
    db,
    {
      type: node.type,
      name: node.name,
      description: node.description,
      content: node.content,
    },
    ctx,
    {
      ...defaultMetadata(ctx, "team", "shared", "promoted"),
      confidence: Math.max(node.confidence, 0.9),
      verificationCount: Math.max(node.verificationCount, 2),
      eventTime: node.eventTime,
      resolvedAt: node.resolvedAt,
      supersededBy: node.supersededBy,
    },
  );

  db.prepare("UPDATE gm_nodes SET promotion_state='promoted', updated_at=? WHERE id=?")
    .run(Date.now(), node.id);

  return {
    promoted: true,
    source: node.id,
    targetScope: ctx.teamId ?? "team-default",
    reason,
  };
}
