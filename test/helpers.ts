import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";

export function createTestDb(): DatabaseSyncInstance {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      scope_type      TEXT NOT NULL DEFAULT 'agent' CHECK(scope_type IN ('session','agent','project','team')),
      scope_id        TEXT NOT NULL,
      visibility      TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','inherited')),
      source_agent_id TEXT,
      source_session_id TEXT,
      project_id      TEXT,
      confidence      REAL NOT NULL DEFAULT 0.6,
      verification_count INTEGER NOT NULL DEFAULT 1,
      promotion_state TEXT NOT NULL DEFAULT 'private' CHECK(promotion_state IN ('private','candidate','promoted')),
      event_time      INTEGER,
      resolved_at     INTEGER,
      superseded_by   TEXT,
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated','stale','superseded','disputed')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_scope_name ON gm_nodes(scope_type, scope_id, name);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_scope ON gm_nodes(scope_type, scope_id, status);

    CREATE TABLE IF NOT EXISTS gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      type        TEXT NOT NULL CHECK(type IN ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
      instruction TEXT NOT NULL,
      condition   TEXT,
      session_id  TEXT NOT NULL,
      scope_type  TEXT NOT NULL DEFAULT 'agent' CHECK(scope_type IN ('session','agent','project','team')),
      scope_id    TEXT NOT NULL,
      visibility  TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','shared','inherited')),
      source_agent_id TEXT,
      project_id  TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to ON gm_edges(to_id);

    CREATE TABLE IF NOT EXISTS gm_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      agent_id    TEXT,
      project_id  TEXT,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_msg_session ON gm_messages(session_id, turn_index);

    CREATE TABLE IF NOT EXISTS gm_signals (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}',
      processed   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_sig_session ON gm_signals(session_id, processed);

    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gm_node_versions (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES gm_nodes(id),
      version_no      INTEGER NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      scope_type      TEXT NOT NULL CHECK(scope_type IN ('session','agent','project','team')),
      scope_id        TEXT NOT NULL,
      visibility      TEXT NOT NULL CHECK(visibility IN ('private','shared','inherited')),
      source_agent_id TEXT,
      source_session_id TEXT,
      project_id      TEXT,
      confidence      REAL NOT NULL DEFAULT 0.6,
      verification_count INTEGER NOT NULL DEFAULT 1,
      promotion_state TEXT NOT NULL CHECK(promotion_state IN ('private','candidate','promoted')),
      event_time      INTEGER,
      resolved_at     INTEGER,
      superseded_by   TEXT,
      status          TEXT NOT NULL CHECK(status IN ('active','deprecated','stale','superseded','disputed')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      captured_at     INTEGER NOT NULL,
      superseded_at   INTEGER,
      reason          TEXT NOT NULL DEFAULT 'superseded'
    );
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
        name, description, content,
        content=gm_nodes, content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ai AFTER INSERT ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ad AFTER DELETE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_au AFTER UPDATE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
    `);
  } catch {
    // FTS5 optional in tests.
  }

  return db;
}

export function insertNode(
  db: DatabaseSyncInstance,
  opts: {
    id?: string;
    type?: string;
    name: string;
    description?: string;
    content?: string;
    status?: string;
    validatedCount?: number;
    sessions?: string[];
    scopeType?: string;
    scopeId?: string;
    visibility?: string;
    sourceAgentId?: string;
    sourceSessionId?: string;
    projectId?: string;
    confidence?: number;
    verificationCount?: number;
    promotionState?: string;
    eventTime?: number | null;
    resolvedAt?: number | null;
    supersededBy?: string | null;
  },
): string {
  const id = opts.id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO gm_nodes (
      id, type, name, description, content, scope_type, scope_id, visibility, source_agent_id, source_session_id,
      project_id, confidence, verification_count, promotion_state, event_time, resolved_at, superseded_by,
      status, validated_count, source_sessions, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.type ?? "SKILL",
    opts.name,
    opts.description ?? `desc of ${opts.name}`,
    opts.content ?? `content of ${opts.name}`,
    opts.scopeType ?? "agent",
    opts.scopeId ?? "test-agent",
    opts.visibility ?? "private",
    opts.sourceAgentId ?? "test-agent",
    opts.sourceSessionId ?? "test-session",
    opts.projectId ?? null,
    opts.confidence ?? 0.65,
    opts.verificationCount ?? 1,
    opts.promotionState ?? "private",
    opts.eventTime ?? null,
    opts.resolvedAt ?? null,
    opts.supersededBy ?? null,
    opts.status ?? "active",
    opts.validatedCount ?? 1,
    JSON.stringify(opts.sessions ?? ["test-session"]),
    Date.now(),
    Date.now(),
  );
  return id;
}

export function insertEdge(
  db: DatabaseSyncInstance,
  opts: {
    fromId: string;
    toId: string;
    type?: string;
    instruction?: string;
  },
): void {
  const id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO gm_edges (id, from_id, to_id, type, instruction, session_id, scope_type, scope_id, visibility, source_agent_id, project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.fromId,
    opts.toId,
    opts.type ?? "USED_SKILL",
    opts.instruction ?? "test instruction",
    "test-session",
    "agent",
    "test-agent",
    "private",
    "test-agent",
    null,
    Date.now(),
  );
}
