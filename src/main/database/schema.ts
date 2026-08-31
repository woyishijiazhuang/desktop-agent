import type { DatabaseSync } from 'node:sqlite'

/**
 * 建表 + 索引。注意：CREATE TABLE IF NOT EXISTS 不会更新已存在表的 schema。
 * 单机单版本部署：schema 变更直接改建表语句、删除旧 data.db 重建，不写迁移。
 * 所有时间列统一 unix 毫秒（INTEGER），与 messages.timestamp 同格式，避免跨表比较/排序需转换。
 */
export function initSchema(db: DatabaseSync): void {
  // 老库 sessions 无 workdir 列时先补列：后续 CREATE INDEX 引用该列，必须在建索引前完成。
  // 新库由下方 CREATE TABLE IF NOT EXISTS 直接含该列，此检查为幂等空操作。
  // 放在 DDL 之前而非文末的轻量列补齐处，否则老库在建索引时即崩溃（no such column）。
  const hasSessionsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get()
  if (hasSessionsTable) {
    const earlySessionCols = (
      db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
    ).map((c) => c.name)
    if (!earlySessionCols.includes('workdir')) {
      db.exec("ALTER TABLE sessions ADD COLUMN workdir TEXT NOT NULL DEFAULT ''")
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新会话',
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'ended')),
      model TEXT,
      thinking_level TEXT,
      system_prompt TEXT,
      -- 所属工作区（workdir 绝对路径）：会话按工作区隔离，空串表示未迁移/默认归属。
      workdir TEXT NOT NULL DEFAULT '',
      -- 最终组装后的系统提示词快照：会话首次创建 Agent 时固化（时间/记忆等一次固定），
      -- 重建 Agent 直接复用，保证 systemPrompt 前缀跨重建稳定、命中 LLM 前缀缓存。
      -- 失效时机：自定义提示词变更（updateSession 自动清空）、全局默认提示词变更（clearResolvedSystemPrompts）。
      resolved_system_prompt TEXT,
      parent_session_id TEXT,
      compress_summary TEXT,
      compress_last_index INTEGER,
      compress_version INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      -- 当前计划（exit_plan_mode 批准后写入，供审阅/回看/跨会话复用；null = 无计划）。
      plan TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_active_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE SET NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      model TEXT,
      provider TEXT,
      finish_reason TEXT,
      timestamp INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('preset','custom')),
      preset_provider TEXT,
      api_format TEXT NOT NULL CHECK(api_format IN ('openai-completions','anthropic-messages')),
      base_url TEXT,
      model_id TEXT NOT NULL,
      context_window INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      multimodal INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      pricing TEXT,
      api_key_encrypted BLOB,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
      command TEXT,
      args TEXT,
      env TEXT,
      url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    ) STRICT;

    -- 旧的 provider 级凭证表已由 model_configs 取代，直接删除。
    DROP TABLE IF EXISTS credentials;

    -- 全文搜索索引：FTS5 表（rowid 与 messages.id 一一对应）。
    -- text 存「提取后的可搜索文本」（2-gram 化，见 toFtsIndexText）。
    -- 不用 content=''（contentless）：该模式不支持 DELETE/UPDATE，而索引需随消息增删改同步。
    -- 索引由消息增删改事务手动同步（FTS5 不跟随 messages 变化，也无级联）。
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      tokenize='unicode61'
    );

    -- 长期记忆（跨会话全局单层）。source 区分手动/自动，自动抽取永不改动手动条目。
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general' CHECK(category IN ('general','preference','fact','project')),
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','auto')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    ) STRICT;

    -- 用量日志：每次 LLM 调用（对话/标题生成/压缩摘要）记录一条，token 统计的唯一数据源。
    -- 不挂在 messages 上：辅助调用（标题/压缩）不产生消息，但同样消耗 token。
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('chat','title','compress','welcome')),
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    ) STRICT;

    -- 记忆全文搜索索引：rowid 为 memories.id 的 FNV-1a 哈希（见 memory.ts rowidKey）。
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      text,
      tokenize='unicode61'
    );

    -- 知识库文档（每行 = 一个导入的文档，源文件存 {userData}/knowledge/original/）。
    CREATE TABLE IF NOT EXISTS kb_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'indexing' CHECK(status IN ('indexing','ready','error')),
      error TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedding_model TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    ) STRICT;

    -- 知识块（切片单元，检索与向量载体）。embedding 为 Float32Array 序列化。
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      start_pos INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      embedding_model TEXT,
      FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
    ) STRICT;

    -- 知识块全文索引：rowid 与 kb_chunks.id 一一对应（2-gram，复用 fts.ts）。
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      text,
      tokenize='unicode61'
    );

    -- 嵌入调用成本日志（embedding 无会话归属，不入 usage_logs，供知识库卡片价格监测）。
    CREATE TABLE IF NOT EXISTS kb_embedding_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_id TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    ) STRICT;

    -- 工作区：一个 workdir 绝对路径对应一个工作区（专属窗口 + 会话集合 + agent.md）。
    CREATE TABLE IF NOT EXISTS workspaces (
      workdir TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      -- 窗口位置/尺寸记忆（JSON 字符串；null = 未记录）。
      bounds TEXT,
      -- 自定义主题色（ThemeColorKey；null = 跟随全局默认，见 settings 的 appearance.themeColor）。
      theme_color TEXT,
      last_opened_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    ) STRICT;

    -- 单用户应用，无 user_id 概念。
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    -- 会话按工作区隔离：列表/回收站按 (workdir, last_active_at) 过滤。
    CREATE INDEX IF NOT EXISTS idx_sessions_workdir_active ON sessions(workdir, last_active_at);
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);
    -- 用量统计按 timestamp 范围过滤（聚合查询），单列索引避免全表扫描。
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_model_configs_updated ON model_configs(updated_at);
    -- 记忆注入/管理按最近更新排序。
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
    -- 用量统计按时间/会话过滤。
    CREATE INDEX IF NOT EXISTS idx_usage_logs_timestamp ON usage_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_logs_session ON usage_logs(session_id);
    -- 知识库：按文档查切片 / 按嵌入模型筛选可参与余弦检索的切片 / 嵌入成本按时间聚合。
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id, seq);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_emb ON kb_chunks(embedding_model);
    CREATE INDEX IF NOT EXISTS idx_kb_embedding_logs_ts ON kb_embedding_logs(timestamp);
  `)

  // 轻量列清理：token 统计已由 usage_logs 取代，物理移除 messages 的 token 用量列与
  // usage_logs 遗留的 source_message_id（仅旧库存在，新建库建表时已不含这些列）。
  const tableCols = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
      (c) => c.name
    )
  for (const col of ['prompt_tokens', 'completion_tokens', 'cost']) {
    if (tableCols('messages').includes(col)) db.exec(`ALTER TABLE messages DROP COLUMN ${col}`)
  }
  db.exec('DROP INDEX IF EXISTS idx_usage_logs_source')
  if (tableCols('usage_logs').includes('source_message_id')) {
    db.exec('ALTER TABLE usage_logs DROP COLUMN source_message_id')
  }

  // 轻量列补齐：老库 model_configs 无 pricing 列时直接补列，保留既有数据
  //（仅新增可空列，不改旧结构；不引入完整迁移体系）。
  const configCols = (
    db.prepare('PRAGMA table_info(model_configs)').all() as unknown as { name: string }[]
  ).map((c) => c.name)
  if (!configCols.includes('pricing')) {
    db.exec('ALTER TABLE model_configs ADD COLUMN pricing TEXT')
  }

  // 轻量列补齐：老库 sessions 无 resolved_system_prompt 列时补列（可空列，保留既有会话）。
  const sessionCols = (
    db.prepare('PRAGMA table_info(sessions)').all() as unknown as { name: string }[]
  ).map((c) => c.name)
  if (!sessionCols.includes('resolved_system_prompt')) {
    db.exec('ALTER TABLE sessions ADD COLUMN resolved_system_prompt TEXT')
  }
  // 轻量列补齐：老库 sessions 无 plan 列时补列（可空列，保留既有会话）。
  if (!sessionCols.includes('plan')) {
    db.exec('ALTER TABLE sessions ADD COLUMN plan TEXT')
  }
  // 轻量列补齐：老库 sessions 无 workdir 列时补列（默认空串，由迁移逻辑回填，见 database/index.ts）。
  if (!sessionCols.includes('workdir')) {
    db.exec("ALTER TABLE sessions ADD COLUMN workdir TEXT NOT NULL DEFAULT ''")
  }
  // 轻量列补齐：老库 workspaces 无 theme_color 列时补列（可空列，null = 跟随全局默认主题色）。
  const workspaceCols = (
    db.prepare('PRAGMA table_info(workspaces)').all() as unknown as { name: string }[]
  ).map((c) => c.name)
  if (!workspaceCols.includes('theme_color')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN theme_color TEXT')
  }
}
