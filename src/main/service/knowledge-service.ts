import { IpcService } from 'electron-ipc-service'
import { app, dialog } from 'electron'
import { join, extname, basename } from 'node:path'
import { copyFile, mkdir, rm, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../database'
import { chunkText } from '../database/knowledge'
import { extractDocumentText } from '../utils/doc-parser'
import {
  decryptKbEmbeddingKey,
  embedTexts,
  embeddingCost,
  embeddingModelKey,
  encryptKbEmbeddingKey,
  resolveKbEmbedding,
  type KbEmbeddingSettings,
  type ResolvedEmbedding
} from '../agent/embedding'
import { SETTING_KB_ENABLED, SETTING_KB_EMBEDDING_CONFIG } from '../agent/types'
import { getDecryptedApiKey } from '../agent/model-config'
import { findBuiltinModel } from '../agent/model-config/preset-catalog'
import type { KbDocument, KbEmbeddingStats, KbSearchHit } from '../database'
import { createLogger } from '../utils/log'

const log = createLogger('knowledge')

/** 需要 mdize 解析的文档格式（doc-parser 支持）。 */
const DOCUMENT_EXTS = new Set(['.docx', '.pdf', '.xlsx', '.pptx', '.csv'])
/** 直接按 UTF-8 读取的纯文本格式。 */
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.xml', '.yaml', '.yml'])
/** 导入对话框可选的扩展名。 */
const IMPORT_FILTER_EXTS = [...DOCUMENT_EXTS, ...TEXT_EXTS].map((e) => e.slice(1))
/** 直接读取的纯文本文件大小上限（超过提示转文档格式）。 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024
/** 纯文本入库的字符上限：与二进制文档解析截断（doc-parser.MAX_EXTRACT_CHARS）对齐，
    避免超大文本切出海量切片导致 embedding/FTS 失控。 */
const MAX_TEXT_CHARS = 300_000

/** 知识库 embedding 配置的展示形态（不含明文 key）。 */
export interface KbEmbeddingView {
  source: 'model' | 'custom'
  /** source='model'：model_configs.id */
  configId: string | null
  /** source='custom'：Base URL */
  baseUrl: string | null
  /** source='custom'：模型 ID */
  modelId: string | null
  hasApiKey: boolean
}

/** 知识库配置（设置页展示用）。 */
export interface KnowledgeConfig {
  enabled: boolean
  /** null = 未配置（检索走关键词兜底） */
  embedding: KbEmbeddingView | null
}

/** 保存 embedding 配置的输入。apiKey：string=覆盖，null=清除，undefined=不变。 */
export type KbEmbeddingPatch =
  | { source: 'model'; configId: string }
  | { source: 'custom'; baseUrl: string; modelId: string; apiKey?: string | null }

/** 测试 embedding 的输入（直接按当前表单值测试，不落库）。 */
export type KbEmbeddingTestInput =
  | { source: 'model'; configId: string }
  | { source: 'custom'; baseUrl: string; modelId: string; apiKey?: string }

/**
 * 知识库服务：配置读写（复用已添加模型 / 自定义配置）/ embedding 测试 / 文档导入入库管道 / 检索 / 嵌入用量。
 * 文档与切片全部本地存储（{userData}/knowledge + SQLite），不回传。
 */
export class KnowledgeService extends IpcService {
  static override readonly namespace = 'knowledge'

  // ==================== 配置 ====================

  getConfig(): KnowledgeConfig {
    return {
      enabled: db.getSetting<boolean>(SETTING_KB_ENABLED) !== false,
      embedding: readEmbeddingView()
    }
  }

  setConfig(patch: { enabled?: boolean; embedding?: KbEmbeddingPatch | null }): KnowledgeConfig {
    if (patch.enabled !== undefined) {
      db.setSetting(SETTING_KB_ENABLED, patch.enabled)
    }
    if (patch.embedding !== undefined) {
      writeEmbeddingSettings(patch.embedding)
    }
    log.info('知识库配置已更新', {
      enabled: patch.enabled,
      embedding: patch.embedding
    })
    return this.getConfig()
  }

  /** 测试 embedding 配置连通性（价格监测按钮）：按输入直接发最小请求，不依赖已保存配置。 */
  async testEmbedding(
    input: KbEmbeddingTestInput
  ): Promise<{ ok: boolean; error?: string; dimension?: number }> {
    let resolved: {
      baseUrl: string
      modelId: string
      apiKey: string
      configId: string
      price: number
    }
    if (input.source === 'model') {
      const config = db.getModelConfig(input.configId)
      if (!config) return { ok: false, error: '模型配置不存在' }
      // 预置（preset）模型的 base_url 在 DB 中为 NULL，回退服务商 catalog 默认地址（与注册逻辑一致）。
      const baseUrl =
        config.baseUrl ??
        (config.presetProvider
          ? findBuiltinModel(config.presetProvider, config.modelId)?.baseUrl
          : null)
      if (!baseUrl) return { ok: false, error: '该模型配置缺少 Base URL' }
      // 本地无鉴权端点（如 Ollama）未配 key 时允许空，请求不带 Authorization 头。
      let apiKey = ''
      try {
        apiKey = getDecryptedApiKey(config.id)
      } catch {
        // 未配置 key：视为无鉴权本地端点
      }
      resolved = {
        baseUrl,
        modelId: config.modelId,
        apiKey,
        configId: config.id,
        price: config.pricing?.input ?? 0
      }
    } else {
      const baseUrl = input.baseUrl.trim()
      const modelId = input.modelId.trim()
      // 表单未填 key 时回退已保存的 custom key（便于「留空=沿用已保存」）；仍为空则视为本地无鉴权端点。
      let apiKey = (input.apiKey ?? '').trim()
      if (!apiKey) {
        const saved = readStoredSettings()
        if (saved?.source === 'custom' && saved.apiKeyEncrypted) {
          try {
            apiKey = decryptKbEmbeddingKey(saved.apiKeyEncrypted)
          } catch {
            apiKey = ''
          }
        }
      }
      if (!baseUrl) return { ok: false, error: '请填写 Base URL' }
      if (!modelId) return { ok: false, error: '请填写模型 ID' }
      resolved = { baseUrl, modelId, apiKey, configId: 'custom', price: 0 }
    }
    try {
      const res = await embedTexts(['ping'], resolved)
      db.recordEmbeddingUsage({
        configId: resolved.configId,
        model: resolved.modelId,
        tokens: res.tokens,
        cost: embeddingCost(res.tokens, resolved.price)
      })
      log.info('embedding 测试通过', { configId: resolved.configId, model: resolved.modelId })
      return { ok: true, dimension: res.vectors[0]?.length }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.warn('embedding 测试失败', { error })
      return { ok: false, error }
    }
  }

  // ==================== 文档管理 ====================

  listDocuments(): KbDocument[] {
    return db.listDocuments()
  }

  /** 弹系统对话框选文件并入库，返回统计。 */
  async importDocuments(): Promise<{ imported: number; skipped: number; failed: number }> {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入文档到知识库',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文档', extensions: IMPORT_FILTER_EXTS }]
    })
    if (canceled || filePaths.length === 0) return { imported: 0, skipped: 0, failed: 0 }

    let imported = 0
    let skipped = 0
    let failed = 0
    for (const filePath of filePaths) {
      try {
        const buf = await readFile(filePath)
        const hash = createHash('sha256').update(buf).digest('hex')
        if (db.findDocumentByHash(hash)) {
          skipped++
          log.info('跳过重复文档', { filePath })
          continue
        }
        await ingestFile(filePath, buf, hash)
        imported++
      } catch (err) {
        failed++
        log.error('文档导入失败', { filePath, error: err })
      }
    }
    log.info('知识库导入完成', { imported, skipped, failed })
    return { imported, skipped, failed }
  }

  /** 删除文档：DB 级联删切片与 FTS，并删除落盘源文件（失败不阻断）。 */
  async deleteDocument(id: string): Promise<void> {
    const doc = db.getDocument(id)
    db.deleteDocument(id)
    if (doc) {
      await rm(doc.storedPath, { force: true }).catch((err) =>
        log.warn('删除知识库源文件失败', { id, error: err })
      )
    }
    log.info('删除知识库文档', { id })
  }

  /** 用当前 embedding 配置批量重算向量（更换配置后旧向量失效时调用）。 */
  async reembedDocuments(ids?: string[]): Promise<{ ok: boolean; error?: string; count: number }> {
    const embedding = resolveKbEmbedding()
    if (!embedding) {
      return { ok: false, error: '未配置 embedding 模型，无法重新嵌入', count: 0 }
    }
    const docs =
      ids && ids.length > 0
        ? ids.map((id) => db.getDocument(id)).filter((d): d is KbDocument => !!d)
        : db.listDocuments()
    const modelKey = embeddingModelKey(embedding)
    let count = 0
    for (const doc of docs) {
      // 后台向量化进行中的文档跳过，避免与导入队列并发写向量
      if (doc.status === 'indexing') continue
      try {
        const chunks = db.listChunks(doc.id)
        if (chunks.length === 0) continue
        const res = await embedTexts(
          chunks.map((c) => c.content),
          embedding
        )
        db.setChunkEmbeddings(
          chunks.map((c) => c.id),
          res.vectors,
          modelKey
        )
        db.recordEmbeddingUsage({
          configId: embedding.configId,
          model: embedding.modelId,
          tokens: res.tokens,
          cost: embeddingCost(res.tokens, embedding.inputPricePerM)
        })
        db.updateDocument(doc.id, { status: 'ready', embeddingModel: modelKey, error: null })
        count++
      } catch (err) {
        db.updateDocument(doc.id, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
        log.error('重新嵌入失败', { docId: doc.id, error: err })
      }
    }
    log.info('知识库重新嵌入完成', { docs: docs.length, success: count, modelKey })
    return { ok: true, count }
  }

  // ==================== 检索与用量 ====================

  /** 管理页搜索测试：与 Agent 的 search_knowledge 同一检索路径（含查询向量化）。 */
  async searchDocuments(query: string, limit = 8): Promise<KbSearchHit[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    const embedding = resolveKbEmbedding()
    let queryVector: Float32Array | null = null
    let vectorModel: string | null = null
    if (embedding && db.hasVectors(embeddingModelKey(embedding))) {
      try {
        const res = await embedTexts([trimmed], embedding)
        queryVector = res.vectors[0] ?? null
        vectorModel = embeddingModelKey(embedding)
        db.recordEmbeddingUsage({
          configId: embedding.configId,
          model: embedding.modelId,
          tokens: res.tokens,
          cost: embeddingCost(res.tokens, embedding.inputPricePerM)
        })
      } catch (err) {
        log.warn('搜索测试查询向量化失败，退化为关键词', { error: err })
      }
    }
    return db.searchKnowledge(trimmed, { limit, queryVector, vectorModel })
  }

  /** 嵌入用量/费用合计（价格监测展示）。 */
  getEmbeddingStats(): KbEmbeddingStats {
    return db.getEmbeddingStats()
  }
}

// ==================== 配置读写辅助 ====================

/** 读 settings → 展示形态（脱敏，不含明文/密文 key）。 */
function readEmbeddingView(): KbEmbeddingView | null {
  const raw = db.getSetting<string>(SETTING_KB_EMBEDDING_CONFIG)
  if (!raw) return null
  let s: KbEmbeddingSettings
  try {
    s = JSON.parse(raw) as KbEmbeddingSettings
  } catch {
    return null
  }
  if (s.source === 'model' && s.configId) {
    return { source: 'model', configId: s.configId, baseUrl: null, modelId: null, hasApiKey: false }
  }
  if (s.source === 'custom') {
    return {
      source: 'custom',
      configId: null,
      baseUrl: s.baseUrl ?? null,
      modelId: s.modelId ?? null,
      hasApiKey: !!s.apiKeyEncrypted
    }
  }
  return null
}

/** 写 settings：合并保存，custom 的 key 经 safeStorage 加密。 */
function writeEmbeddingSettings(patch: KbEmbeddingPatch | null): void {
  if (patch === null) {
    db.deleteSetting(SETTING_KB_EMBEDDING_CONFIG)
    return
  }
  if (patch.source === 'model') {
    if (!db.getModelConfig(patch.configId)) {
      throw new Error('所选模型配置不存在')
    }
    db.setSetting(
      SETTING_KB_EMBEDDING_CONFIG,
      JSON.stringify({ source: 'model', configId: patch.configId } satisfies KbEmbeddingSettings)
    )
    return
  }
  // custom：保留已存 key（apiKey 为 undefined 时不变）
  const baseUrl = patch.baseUrl.trim()
  const modelId = patch.modelId.trim()
  if (!baseUrl || !modelId) throw new Error('请填写 Base URL 与模型 ID')
  const prev = readStoredSettings()
  let apiKeyEncrypted = prev?.source === 'custom' ? prev.apiKeyEncrypted : undefined
  if (patch.apiKey !== undefined) {
    apiKeyEncrypted = patch.apiKey === null ? undefined : encryptKbEmbeddingKey(patch.apiKey.trim())
  }
  db.setSetting(
    SETTING_KB_EMBEDDING_CONFIG,
    JSON.stringify({
      source: 'custom',
      baseUrl,
      modelId,
      apiKeyEncrypted
    } satisfies KbEmbeddingSettings)
  )
}

function readStoredSettings(): KbEmbeddingSettings | null {
  const raw = db.getSetting<string>(SETTING_KB_EMBEDDING_CONFIG)
  if (!raw) return null
  try {
    return JSON.parse(raw) as KbEmbeddingSettings
  } catch {
    return null
  }
}

// ==================== 入库管道 ====================

/** 单文件入库：解析 → 切片 → 落库 →（配置了 embedding 则）批量向量化。 */
async function ingestFile(filePath: string, buf: Buffer, hash: string): Promise<void> {
  const ext = extname(filePath).toLowerCase()
  const fileName = basename(filePath)
  const title = fileName.replace(/\.[^.]+$/, '')

  // 1. 提取纯文本：纯文本直接读；docx/pdf 等走 mdize 解析。
  //    校验/解析成功后再复制源文件，避免失败导入在 original/ 留下无 DB 引用的孤儿文件。
  let text: string
  if (TEXT_EXTS.has(ext)) {
    if (buf.length > MAX_TEXT_BYTES) {
      throw new Error(`纯文本文件超过 ${MAX_TEXT_BYTES / 1024 / 1024}MB，请先另存为文档格式`)
    }
    text = buf.toString('utf-8').slice(0, MAX_TEXT_CHARS)
  } else if (DOCUMENT_EXTS.has(ext)) {
    text = await extractDocumentText(buf, fileName)
  } else {
    throw new Error(`不支持的文档格式：${ext}`)
  }

  // 2. 复制源文件到知识库目录（保持原始文件，供溯源/重算）。
  const storedPath = join(app.getPath('userData'), 'knowledge', 'original', `${randomUUID()}${ext}`)
  await mkdir(join(app.getPath('userData'), 'knowledge', 'original'), { recursive: true })
  await copyFile(filePath, storedPath)

  // 3. 建文档记录 + 切片 + FTS 索引。
  const doc = db.createDocument({ title, fileName, fileHash: hash, storedPath })
  const chunks = chunkText(text)
  const chunkIds = db.insertChunks(
    doc.id,
    chunks.map((c) => ({ seq: c.seq, title: c.title, content: c.content, startPos: c.startPos }))
  )
  if (chunkIds.length === 0) {
    db.updateDocument(doc.id, { status: 'ready', chunkCount: 0, embeddingModel: null })
    return
  }

  // 4. 配置了 embedding 则后台向量化：先以 indexing 状态落库（文档立即出现在管理列表），
  //    嵌入在后台队列逐个完成后再更新为 ready / error，避免导入按钮长时间转圈。
  const embedding = resolveKbEmbedding()
  if (embedding && chunkIds.length > 0) {
    db.updateDocument(doc.id, { status: 'indexing', chunkCount: chunkIds.length, error: null })
    void queueEmbedDocument(doc.id, chunkIds, chunks, embedding)
  } else {
    db.updateDocument(doc.id, {
      status: 'ready',
      chunkCount: chunkIds.length,
      embeddingModel: null
    })
  }
  log.info('文档入库完成', { docId: doc.id, fileName, chunks: chunkIds.length })
}

// ==================== 后台嵌入队列 ====================

/** 文档嵌入串行队列：多文档导入时逐个向量化，避免并发打爆本地端点（如 Ollama）。 */
let embedQueue: Promise<void> = Promise.resolve()

/** 入队一个文档的向量化任务（fire-and-forget，失败已在任务内处理）。 */
function queueEmbedDocument(
  docId: string,
  chunkIds: number[],
  chunks: { seq: number; title: string | null; content: string; startPos: number }[],
  embedding: ResolvedEmbedding
): void {
  embedQueue = embedQueue
    .then(() => embedDocument(docId, chunkIds, chunks, embedding))
    .catch((err) => log.error('后台嵌入任务异常', { docId, error: err }))
}

/** 单个文档向量化：成功置 ready，失败置 error（切片保留，可重新嵌入）。 */
async function embedDocument(
  docId: string,
  chunkIds: number[],
  chunks: { seq: number; title: string | null; content: string; startPos: number }[],
  embedding: ResolvedEmbedding
): Promise<void> {
  const modelKey = embeddingModelKey(embedding)
  try {
    const res = await embedTexts(
      chunks.map((c) => c.content),
      embedding
    )
    db.setChunkEmbeddings(chunkIds, res.vectors, modelKey)
    db.recordEmbeddingUsage({
      configId: embedding.configId,
      model: embedding.modelId,
      tokens: res.tokens,
      cost: embeddingCost(res.tokens, embedding.inputPricePerM)
    })
    db.updateDocument(docId, {
      status: 'ready',
      chunkCount: chunkIds.length,
      embeddingModel: modelKey
    })
    log.info('文档向量化完成', { docId, chunks: chunkIds.length, modelKey })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    db.updateDocument(docId, { status: 'error', error, chunkCount: chunkIds.length })
    log.warn('文档向量化失败（已保留切片，可重新嵌入）', { docId, error })
  }
}
