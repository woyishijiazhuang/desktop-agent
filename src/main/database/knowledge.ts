import type { DatabaseSync } from 'node:sqlite'
import type {
  KbChunk,
  KbDocument,
  KbDocumentStatus,
  KbEmbeddingStats,
  KbSearchHit,
  ChunkOptions
} from './types'
import { transaction } from './utils'
import { bigramTokens, toFtsIndexText, toFtsMatchQuery, toFtsOrQuery } from './fts'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../utils/log'

const log = createLogger('db')

/** 切片默认参数：目标块 800 字，相邻块重叠 100 字。 */
export const DEFAULT_CHUNK_SIZE = 800
export const DEFAULT_CHUNK_OVERLAP = 100

/** 检索候选上限（FTS 预筛 + 余弦重排均在候选集内做）。 */
const CANDIDATE_LIMIT = 100
/** OR 降级检索的候选上限（任一 2-gram 命中可能召回较多，放宽到 300）。 */
const OR_CANDIDATE_LIMIT = 300
/** 单条检索命中返回的内容上限（控制注入 token）。 */
const HIT_CONTENT_LIMIT = 800

/** 切片结果（入库前形态）。 */
export interface TextChunk {
  seq: number
  /** 所在小节标题 */
  title: string | null
  content: string
  /** 在源文本中的偏移 */
  startPos: number
}

/** 新建文档输入。 */
export interface CreateKbDocumentInput {
  title: string
  fileName: string
  fileHash: string
  storedPath: string
}

/** 切片插入输入。 */
export interface InsertChunkInput {
  seq: number
  title: string | null
  content: string
  startPos: number
}

/**
 * 知识库域 API（index.ts 组装进 db 门面）。
 * 文档/切片 CRUD + FTS 同步 + 向量存取 + 嵌入成本 + 混合检索。
 */
export interface KnowledgeApi {
  // ---- 文档 ----
  listDocuments(): KbDocument[]
  getDocument(id: string): KbDocument | undefined
  findDocumentByHash(hash: string): KbDocument | undefined
  createDocument(input: CreateKbDocumentInput): KbDocument
  updateDocument(
    id: string,
    patch: Partial<Pick<KbDocument, 'status' | 'error' | 'chunkCount' | 'embeddingModel'>>
  ): KbDocument
  deleteDocument(id: string): void

  // ---- 切片 ----
  /** 事务内插入切片 + 同步 FTS 索引，返回各切片 id（供后续写入向量）。 */
  insertChunks(docId: string, chunks: InsertChunkInput[]): number[]
  listChunks(docId: string): KbChunk[]
  /** 批量写入向量（事务）。embeddingModel 为生成时的 {configId}:{modelId}。 */
  setChunkEmbeddings(chunkIds: number[], vectors: Float32Array[], embeddingModel: string): void
  /** 清空向量（更换 embedding 模型后旧向量失效）。不传 chunkIds 则清空全部，返回清除条数。 */
  clearChunkEmbeddings(chunkIds?: number[]): number

  // ---- 嵌入成本 ----
  recordEmbeddingUsage(params: {
    configId: string
    model: string
    tokens: number
    cost: number
  }): void
  getEmbeddingStats(): KbEmbeddingStats

  /** 是否存在使用指定 embedding_model（{configId}:{modelId}）生成的向量（查询是否需要嵌入）。 */
  hasVectors(modelKey: string): boolean

  // ---- 检索 ----
  /**
   * 混合检索：FTS5 2-gram 预筛 → 有 queryVector 时对候选做余弦重排，
   * 否则 2-gram 重叠打分兜底。返回 top-K 命中（含溯源信息）。
   */
  searchKnowledge(
    query: string,
    opts?: { limit?: number; queryVector?: Float32Array | null; vectorModel?: string | null }
  ): KbSearchHit[]
}

/** 知识库域实现。 */
export function createKnowledgeApi(db: DatabaseSync): KnowledgeApi {
  const api: KnowledgeApi = {
    listDocuments(): KbDocument[] {
      const rows = db
        .prepare('SELECT * FROM kb_documents ORDER BY created_at DESC')
        .all() as unknown as KbDocumentRow[]
      return rows.map(toKbDocument)
    },

    getDocument(id: string): KbDocument | undefined {
      const row = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id) as unknown as
        KbDocumentRow | undefined
      return row ? toKbDocument(row) : undefined
    },

    findDocumentByHash(hash: string): KbDocument | undefined {
      const row = db
        .prepare('SELECT * FROM kb_documents WHERE file_hash = ?')
        .get(hash) as unknown as KbDocumentRow | undefined
      return row ? toKbDocument(row) : undefined
    },

    createDocument(input: CreateKbDocumentInput): KbDocument {
      const id = randomUUID()
      const now = Date.now()
      db.prepare(
        `INSERT INTO kb_documents
          (id, title, file_name, file_hash, stored_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'indexing', ?, ?)`
      ).run(id, input.title, input.fileName, input.fileHash, input.storedPath, now, now)
      return api.getDocument(id)!
    },

    updateDocument(
      id: string,
      patch: Partial<Pick<KbDocument, 'status' | 'error' | 'chunkCount' | 'embeddingModel'>>
    ): KbDocument {
      const sets: string[] = []
      const values: (string | number | null)[] = []
      if (patch.status !== undefined) {
        if (!isDocStatus(patch.status)) throw new Error(`非法的文档状态: ${patch.status}`)
        sets.push('status = ?')
        values.push(patch.status)
      }
      if (patch.error !== undefined) {
        sets.push('error = ?')
        values.push(patch.error)
      }
      if (patch.chunkCount !== undefined) {
        sets.push('chunk_count = ?')
        values.push(patch.chunkCount)
      }
      if (patch.embeddingModel !== undefined) {
        sets.push('embedding_model = ?')
        values.push(patch.embeddingModel)
      }
      if (sets.length > 0) {
        sets.push('updated_at = ?')
        values.push(Date.now())
        values.push(id)
        db.prepare(`UPDATE kb_documents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      }
      return api.getDocument(id)!
    },

    deleteDocument(id: string): void {
      transaction(db, () => {
        const chunkIds = (
          db.prepare('SELECT id FROM kb_chunks WHERE doc_id = ?').all(id) as { id: number }[]
        ).map((r) => r.id)
        for (const cid of chunkIds) {
          db.prepare('DELETE FROM kb_chunks_fts WHERE rowid = ?').run(cid)
        }
        db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id)
      })
      // FTS5 的 DELETE 是逻辑删除（tombstone 标记），底层 _data/_idx 段不会立即释放；
      // optimize 合并段并回收物理空间（删除是低频操作，全表合并可接受）。
      db.exec("INSERT INTO kb_chunks_fts(kb_chunks_fts) VALUES('optimize')")
    },

    insertChunks(docId: string, chunks: InsertChunkInput[]): number[] {
      if (chunks.length === 0) return []
      return transaction(db, () => {
        const insertChunk = db.prepare(
          `INSERT INTO kb_chunks (doc_id, seq, title, content, start_pos)
           VALUES (?, ?, ?, ?, ?)`
        )
        const insertFts = db.prepare('INSERT INTO kb_chunks_fts (rowid, text) VALUES (?, ?)')
        const ids: number[] = []
        for (const c of chunks) {
          const r = insertChunk.run(docId, c.seq, c.title, c.content, c.startPos)
          const chunkId = Number(r.lastInsertRowid)
          insertFts.run(chunkId, toFtsIndexText(c.content))
          ids.push(chunkId)
        }
        return ids
      })
    },

    listChunks(docId: string): KbChunk[] {
      const rows = db
        .prepare('SELECT * FROM kb_chunks WHERE doc_id = ? ORDER BY seq ASC')
        .all(docId) as unknown as KbChunkRow[]
      return rows.map(toKbChunk)
    },

    setChunkEmbeddings(chunkIds: number[], vectors: Float32Array[], embeddingModel: string): void {
      if (chunkIds.length !== vectors.length || chunkIds.length === 0) return
      transaction(db, () => {
        const stmt = db.prepare(
          'UPDATE kb_chunks SET embedding = ?, embedding_model = ? WHERE id = ?'
        )
        for (let i = 0; i < chunkIds.length; i++) {
          stmt.run(vecToBuffer(vectors[i]), embeddingModel, chunkIds[i])
        }
      })
    },

    clearChunkEmbeddings(chunkIds?: number[]): number {
      return transaction(db, () => {
        if (chunkIds && chunkIds.length > 0) {
          const stmt = db.prepare(
            'UPDATE kb_chunks SET embedding = NULL, embedding_model = NULL WHERE id = ?'
          )
          for (const id of chunkIds) stmt.run(id)
          return chunkIds.length
        }
        const r = db.prepare('UPDATE kb_chunks SET embedding = NULL, embedding_model = NULL').run()
        return Number(r.changes)
      })
    },

    recordEmbeddingUsage(params: {
      configId: string
      model: string
      tokens: number
      cost: number
    }): void {
      db.prepare(
        `INSERT INTO kb_embedding_logs (config_id, model, tokens, cost, timestamp)
         VALUES (?, ?, ?, ?, ?)`
      ).run(params.configId, params.model, params.tokens, params.cost, Date.now())
    },

    getEmbeddingStats(): KbEmbeddingStats {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
           FROM kb_embedding_logs`
        )
        .get() as unknown as { calls: number; tokens: number; cost: number }
      return { calls: row.calls, tokens: row.tokens, cost: row.cost }
    },

    hasVectors(modelKey: string): boolean {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM kb_chunks WHERE embedding_model = ?')
        .get(modelKey) as unknown as { c: number }
      return row.c > 0
    },

    searchKnowledge(
      query: string,
      opts: { limit?: number; queryVector?: Float32Array | null; vectorModel?: string | null } = {}
    ): KbSearchHit[] {
      const trimmed = query.trim()
      if (!trimmed) return []
      const limit = opts.limit ?? 8
      const queryVector = opts.queryVector ?? null
      const vectorModel = opts.vectorModel ?? null

      // FTS5 2-gram 预筛：AND 全命中优先；无命中时降级为 OR（任一 2-gram 命中），
      // 避免长查询因单个 bigram（如「会话压缩设计」的「缩设」）在文档中不存在而整体失配，
      // 候选集随后交给 JS 打分（余弦 / 2-gram 重叠计数）排序。
      let match = toFtsMatchQuery(trimmed)
      let candidateLimit = CANDIDATE_LIMIT
      if (!match) {
        match = toFtsOrQuery(trimmed)
        candidateLimit = OR_CANDIDATE_LIMIT
      }
      if (!match) return []
      const candidates = db
        .prepare(
          `SELECT c.id, c.doc_id, c.seq, c.title, c.content, c.embedding, c.embedding_model,
                  d.title AS doc_title
           FROM kb_chunks_fts f
           JOIN kb_chunks c ON c.id = f.rowid
           JOIN kb_documents d ON d.id = c.doc_id AND d.status IN ('ready', 'error')
           WHERE kb_chunks_fts MATCH ?
           LIMIT ?`
        )
        .all(match, candidateLimit) as unknown as KbChunkSearchRow[]

      if (candidates.length === 0) return []

      // 打分：
      // - 向量模式（queryVector 有效）：仅与当前 embedding_model 匹配的块参与余弦重排，
      //   其余块记 -1（向量模式直接剔除，避免无关旧模型块混入结果污染上下文）。
      // - 关键词模式：2-gram 重叠计数兜底。
      const tokens = new Set(bigramTokens(trimmed.toLowerCase()))
      const vectorMode = !!queryVector && !!vectorModel
      const scored = candidates.map((r) => {
        let score: number
        if (vectorMode) {
          if (queryVector && r.embedding_model === vectorModel && r.embedding) {
            score = cosineSimilarity(queryVector, bufToVec(r.embedding))
          } else {
            score = -1
          }
        } else {
          score = 0
          const content = r.content.toLowerCase()
          for (const t of tokens) if (content.includes(t)) score++
        }
        return { r, score }
      })
      scored.sort((a, b) => b.score - a.score || a.r.id - b.r.id)
      // 向量模式下过滤「embedding 模型不匹配 / 未向量化」的候选（error 文档的切片无向量，
      // 天然被排除在向量检索之外；关键词检索不受影响，仍可命中）。
      const pool = vectorMode ? scored.filter((s) => s.score >= 0) : scored
      const hits = pool.slice(0, limit).map(({ r, score }) => ({
        chunkId: r.id,
        docId: r.doc_id,
        docTitle: r.doc_title,
        title: r.title,
        content: truncate(r.content, HIT_CONTENT_LIMIT),
        score,
        seq: r.seq
      }))
      log.debug('知识库检索', { query: trimmed, candidates: candidates.length, hits: hits.length })
      return hits
    }
  }
  return api
}

// ==================== 切片器 ====================

/** 按标题分节 + 字符切块：目标 maxChars、相邻块重叠 overlap。 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(200, opts.maxChars ?? DEFAULT_CHUNK_SIZE)
  const overlap = Math.max(
    0,
    Math.min(opts.overlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(maxChars / 2))
  )
  const sections = splitSections(text)
  const out: TextChunk[] = []
  let seq = 0
  for (const section of sections) {
    const body = section.text.trim()
    if (!body) continue
    let start = 0
    while (start < body.length) {
      let end = Math.min(start + maxChars, body.length)
      if (end < body.length) {
        // 优先在段落边界（空行）处切断，避免切在句子中间
        const nearBreak = body.lastIndexOf('\n\n', end)
        if (nearBreak > start + maxChars * 0.5) end = nearBreak
      }
      const content = body.slice(start, end).trim()
      if (content) {
        out.push({ seq: seq++, title: section.title, content, startPos: section.startPos + start })
      }
      if (end >= body.length) break
      start = Math.max(end - overlap, start + 1)
    }
  }
  return out
}

/** 按 Markdown 标题（#~####）切分文档为「节」，保留小节标题供溯源。 */
function splitSections(text: string): { title: string | null; text: string; startPos: number }[] {
  const sections: { title: string | null; text: string; startPos: number }[] = []
  let title: string | null = null
  let buffer: { line: string; pos: number }[] = []
  let sectionStart = 0
  const flush = (): void => {
    if (buffer.length === 0) return
    sections.push({ title, text: buffer.map((b) => b.line).join('\n'), startPos: sectionStart })
    buffer = []
  }
  const lines = text.split('\n')
  let pos = 0
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      flush()
      title = line.replace(/^#{1,4}\s+/, '').trim()
      sectionStart = pos
    } else {
      buffer.push({ line, pos })
    }
    pos += line.length + 1
  }
  flush()
  return sections
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

// ==================== 向量辅助 ====================

/** Float32Array → BLOB（共享底层 buffer 的拷贝，避免持有大 ArrayBuffer 引用）。 */
export function vecToBuffer(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

/** BLOB → Float32Array。 */
export function bufToVec(buf: Uint8Array): Float32Array {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(copy)
}

/** 余弦相似度（未归一化向量）。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ==================== 行映射 ====================

function isDocStatus(v: unknown): v is KbDocumentStatus {
  return v === 'indexing' || v === 'ready' || v === 'error'
}

interface KbDocumentRow {
  id: string
  title: string
  file_name: string
  file_hash: string
  stored_path: string
  status: string
  error: string | null
  chunk_count: number
  embedding_model: string | null
  created_at: number
  updated_at: number
}

function toKbDocument(row: KbDocumentRow): KbDocument {
  return {
    id: row.id,
    title: row.title,
    fileName: row.file_name,
    fileHash: row.file_hash,
    storedPath: row.stored_path,
    status: isDocStatus(row.status) ? row.status : 'error',
    error: row.error,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

interface KbChunkRow {
  id: number
  doc_id: string
  seq: number
  title: string | null
  content: string
  start_pos: number
  embedding: Uint8Array | null
  embedding_model: string | null
}

function toKbChunk(row: KbChunkRow): KbChunk {
  return {
    id: row.id,
    docId: row.doc_id,
    seq: row.seq,
    title: row.title,
    content: row.content,
    startPos: row.start_pos,
    embedding: row.embedding,
    embeddingModel: row.embedding_model
  }
}

interface KbChunkSearchRow extends KbChunkRow {
  doc_title: string
}
