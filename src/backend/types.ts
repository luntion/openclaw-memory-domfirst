import type {
  AuditFinding,
  CandidateReviewAction,
  CandidateReviewResult,
  GmConfig,
  GmEdge,
  GmNode,
  GmNodeVersion,
  MemoryLineage,
  MemoryMetadata,
  RecallPlan,
  RecallResult,
  ScopeContext,
  ScopeFilter,
} from "../types.ts";

export interface MessageRecord {
  id: string;
  session_id: string;
  agent_id?: string | null;
  project_id?: string | null;
  turn_index: number;
  role: string;
  content: string;
  extracted: number;
  created_at: number;
}

export interface EpisodicMessage {
  role: string;
  text: string;
}

export interface ScopedStats {
  totalNodes: number;
  totalEdges: number;
  communities: number;
  byType?: Record<string, number>;
  byEdgeType?: Record<string, number>;
  scopedNodeIds?: string[];
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
  source?: string;
  targetScope?: string;
}

export interface MemoryGraphStore {
  upsertNode(
    input: { type: GmNode["type"]; name: string; description: string; content: string },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ): Promise<{ node: GmNode; created: boolean }>;
  upsertEdge(
    input: {
      fromId: string;
      toId: string;
      type: GmEdge["type"];
      instruction: string;
      condition?: string;
    },
    ctx: ScopeContext,
    meta?: Partial<MemoryMetadata>,
  ): Promise<void>;
  getSessionNodes(sessionId: string, filters?: ScopeFilter[]): Promise<GmNode[]>;
  getEdgesForNode(nodeId: string): Promise<GmEdge[]>;
  stats(filters?: ScopeFilter[]): Promise<ScopedStats>;
  findNodeByName(name: string, filters?: ScopeFilter[]): Promise<GmNode | null>;
  inspect(name: string, filters?: ScopeFilter[]): Promise<{ nodes: GmNode[]; versions: GmNodeVersion[] }>;
  listCandidates(filters?: ScopeFilter[], limit?: number): Promise<GmNode[]>;
  markCandidate(nodeId: string): Promise<void>;
  promote(name: string, ctx: ScopeContext, explicit?: boolean): Promise<PromotionResult>;
  lineage(name: string, filters?: ScopeFilter[]): Promise<MemoryLineage>;
  reviewCandidate(
    name: string,
    ctx: ScopeContext,
    action: CandidateReviewAction,
    targetName?: string,
  ): Promise<CandidateReviewResult>;
  audit(filters?: ScopeFilter[]): Promise<AuditFinding[]>;
}

export interface MessageStore {
  saveMessage(sessionId: string, turnIndex: number, role: string, content: unknown): void;
  getMessages(sessionId: string, limit?: number): MessageRecord[];
  getUnextracted(sessionId: string, limit: number): MessageRecord[];
  markExtracted(sessionId: string, upToTurn: number): void;
  getEpisodicMessages(sessionIds: string[], beforeTs: number, limitChars: number): EpisodicMessage[];
}

export interface RecallBackend {
  setEmbedFn(fn: ((text: string) => Promise<number[]>) | null): void;
  recall(query: string, plan: RecallPlan): Promise<RecallResult>;
}

export interface BackendRuntime {
  config: GmConfig;
  graphStore: MemoryGraphStore;
  messageStore: MessageStore;
  recallBackend: RecallBackend;
  health(): Promise<Record<string, unknown>>;
  dispose?(): Promise<void>;
}
