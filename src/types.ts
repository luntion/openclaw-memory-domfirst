/**
 * openclaw-memory-domfirst
 *
 * Graph-memory-first hybrid memory types.
 */

export type NodeType = "TASK" | "SKILL" | "EVENT";
export type NodeStatus = "active" | "deprecated" | "stale" | "superseded" | "disputed";
export type ScopeType = "session" | "agent" | "project" | "team";
export type Visibility = "private" | "shared" | "inherited";
export type PromotionState = "private" | "candidate" | "promoted";
export type RecallDepth = "L0" | "L1" | "L2" | "L3";
export type BackendMode = "sqlite" | "graphiti-neo4j";
export type CandidateReviewAction = "approve" | "reject" | "defer" | "merge-into-existing";

export interface ScopeFilter {
  scopeType: ScopeType;
  scopeIds?: string[];
}

export interface ScopeContext {
  sessionId: string;
  agentId: string;
  projectId?: string;
  teamId?: string;
  userId?: string;
}

export interface MemoryMetadata {
  scopeType: ScopeType;
  scopeId: string;
  visibility: Visibility;
  sourceAgentId?: string | null;
  sourceSessionId?: string | null;
  projectId?: string | null;
  confidence: number;
  verificationCount: number;
  promotionState: PromotionState;
  eventTime?: number | null;
  resolvedAt?: number | null;
  supersededBy?: string | null;
}

export interface GmNode extends MemoryMetadata {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
}

export interface GmNodeVersion extends MemoryMetadata {
  id: string;
  nodeId: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
  capturedAt: number;
  supersededAt: number | null;
  versionNo: number;
  reason: string;
  timelineLabel?: string;
}

export type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH";

export interface GmEdge {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  instruction: string;
  condition?: string;
  sessionId: string;
  scopeType: ScopeType;
  scopeId: string;
  visibility: Visibility;
  sourceAgentId?: string | null;
  projectId?: string | null;
  createdAt: number;
}

export type SignalType =
  | "tool_error"
  | "tool_success"
  | "skill_invoked"
  | "user_correction"
  | "explicit_record"
  | "task_completed";

export interface Signal {
  type: SignalType;
  turnIndex: number;
  data: Record<string, any>;
}

export interface ExtractionResult {
  nodes: Array<{
    type: NodeType;
    name: string;
    description: string;
    content: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
    condition?: string;
  }>;
}

export interface FinalizeResult {
  promotedSkills: Array<{
    type: "SKILL";
    name: string;
    description: string;
    content: string;
  }>;
  newEdges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
  }>;
  invalidations: string[];
}

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  tokenEstimate: number;
  timelineSummary?: string;
  timeline?: Array<{
    name: string;
    versions: Array<{
      id: string;
      nodeId: string;
      versionNo: number;
      content: string;
      description: string;
      capturedAt: number;
      supersededAt: number | null;
      timelineLabel?: string;
    }>;
  }>;
}

export interface MemoryLineage {
  name: string;
  nodes: GmNode[];
  versions: GmNodeVersion[];
  sources: Array<{
    scopeType: ScopeType;
    scopeId: string;
    sourceAgentId?: string | null;
    sourceSessionId?: string | null;
    projectId?: string | null;
    promotionState: PromotionState;
    confidence: number;
    verificationCount: number;
    status: NodeStatus;
  }>;
}

export interface AuditFinding {
  name: string;
  scopeType: ScopeType;
  scopeId: string;
  severity: "low" | "medium" | "high";
  reason: string;
  status: NodeStatus;
  promotionState: PromotionState;
  confidence: number;
  verificationCount: number;
}

export interface CandidateReviewResult {
  ok: boolean;
  action: CandidateReviewAction;
  name: string;
  reason: string;
}

export interface BackendDiagnostics {
  backend: BackendMode;
  health: Record<string, unknown>;
  scopeStats: {
    session: number;
    agent: number;
    project: number;
    team: number;
  };
  candidateCount: number;
  auditFindingCount: number;
  sampleCandidates: Array<{
    name: string;
    scopeType: ScopeType;
    scopeId: string;
    verificationCount: number;
    confidence: number;
    promotionState: PromotionState;
  }>;
  sampleAuditFindings: Array<{
    name: string;
    scopeType: ScopeType;
    scopeId: string;
    severity: "low" | "medium" | "high";
    reason: string;
  }>;
}

export interface RecallPlan {
  depth: RecallDepth;
  includeTeam: boolean;
  maxNodes: number;
  maxDepth: number;
  reason: string;
  scopeFilters: ScopeFilter[];
  timeRange?: {
    start?: number;
    end?: number;
    label: string;
  };
  preferRecent?: boolean;
  temporalMode?: "current" | "past" | "evolution";
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

export interface GraphitiBackendConfig {
  baseUrl: string;
  groupPrefix: string;
  timeoutMs: number;
}

export interface Neo4jBackendConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  workspace: string;
}

export interface BackendConfig {
  mode: BackendMode;
  graphiti: GraphitiBackendConfig;
  neo4j: Neo4jBackendConfig;
}

export interface GmConfig {
  dbPath: string;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  servicePort: number;
  serviceHost: string;
  teamId: string;
  defaultAgentId: string;
  defaultProjectId?: string;
  knowledgeMarkers: string[];
  embedding?: EmbeddingConfig;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  backend: BackendConfig;
  dedupThreshold: number;
  pagerankDamping: number;
  pagerankIterations: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  dbPath: "~/.openclaw/openclaw-memory-domfirst.db",
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  servicePort: 42690,
  serviceHost: "127.0.0.1",
  teamId: "team-default",
  defaultAgentId: "agent-main",
  knowledgeMarkers: ["knowledge: true", "memory-scope:", "team-memory: true"],
  backend: {
    mode: "sqlite",
    graphiti: {
      baseUrl: "http://127.0.0.1:8000",
      groupPrefix: "ocm",
      timeoutMs: 20_000,
    },
    neo4j: {
      uri: "bolt://127.0.0.1:7687",
      username: "neo4j",
      password: "password",
      database: "neo4j",
      workspace: "main",
    },
  },
  dedupThreshold: 0.9,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
};
