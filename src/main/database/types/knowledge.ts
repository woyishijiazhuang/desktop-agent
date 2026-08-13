/** 知识库域类型：文档 / 切片 / 检索 / 嵌入用量。 */

/** 文档处理状态：indexing 解析入库中 / ready 可用 / error 失败。 */
export type KbDocumentStatus = 'indexing' | 'ready' | 'error'

/** 知识库文档实体（kb_documents 行）。 */
export interface KbDocument {
  id: string
  /** 展示名（文件名去扩展名） */
  title: string
  /** 原始文件名 */
  fileName: string
  /** sha256（导入去重） */
  fileHash: string
  /** 源文件落盘路径（{userData}/knowledge/original/{id}.{ext}） */
  storedPath: string
  status: KbDocumentStatus
  /** 失败原因（status=error 时） */
  error: string | null
  /** 切片数 */
  chunkCount: number
  /** 嵌入所用 {configId}:{modelId}，未嵌入为 null */
  embeddingModel: string | null
  createdAt: number
  updatedAt: number
}

/** 知识块（切片）实体（kb_chunks 行）。 */
export interface KbChunk {
  id: number
  docId: string
  /** 文档内序号 */
  seq: number
  /** 所在小节标题（溯源展示） */
  title: string | null
  content: string
  /** 在源文本中的偏移（溯源） */
  startPos: number
  /** Float32Array 序列化（BLOB），null = 未嵌入 */
  embedding: Uint8Array | null
  /** 生成向量时的 {configId}:{modelId} */
  embeddingModel: string | null
}

/** 检索结果（searchKnowledge 返回，含溯源信息）。 */
export interface KbSearchHit {
  chunkId: number
  docId: string
  /** 文档展示名 */
  docTitle: string
  /** 小节标题 */
  title: string | null
  /** 切片内容（已按 maxChars 截断） */
  content: string
  /** 相关度得分（余弦相似度或关键词重叠数） */
  score: number
  /** 文档内序号 */
  seq: number
}

/** 嵌入调用日志（kb_embedding_logs 行），价格监测数据源。 */
export interface KbEmbeddingLog {
  id: number
  /** model_configs.id */
  configId: string
  model: string
  tokens: number
  /** 成本（USD） */
  cost: number
  timestamp: number
}

/** 嵌入用量/费用合计（价格监测展示）。 */
export interface KbEmbeddingStats {
  /** 累计调用次数 */
  calls: number
  /** 累计 token */
  tokens: number
  /** 累计成本（USD） */
  cost: number
}

/** 切片参数（默认 800 字 / 重叠 100 字）。 */
export interface ChunkOptions {
  /** 目标块大小（字符） */
  maxChars?: number
  /** 相邻块重叠（字符） */
  overlap?: number
}
