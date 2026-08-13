<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NCard,
  NButton,
  NTag,
  NPopconfirm,
  NInput,
  NSelect,
  NSwitch,
  NSpace,
  NAlert,
  NRadioGroup,
  NRadioButton,
  useMessage
} from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { formatCost, formatTokens } from '@renderer/utils/format'
import type { KbDocument, KbSearchHit } from '@main/service/db-service'
import ToolSwitches from './ToolSwitches.vue'

/** 知识库域工具：Agent 通过它检索知识库。 */
const KB_TOOLS = new Set(['search_knowledge'])

const settings = useSettingsStore()
const modelConfigs = useModelConfigsStore()
const message = useMessage()

/** 知识库工具开关列表。 */
const kbTools = computed(() => settings.tools.filter((t) => KB_TOOLS.has(t.name)))

// ---- embedding 配置：复用已添加模型 / 自定义配置 ----
/** 当前来源：model = 使用已添加模型，custom = 知识库专属自定义配置。 */
const embeddingSource = ref<'model' | 'custom'>('model')
/** model 模式：选中的模型配置 id。 */
const selectedConfigId = ref<string | null>(null)
/** custom 模式：Base URL / 模型 ID / API Key（key 仅输入用，不入库明文）。 */
const customBaseUrl = ref('')
const customModelId = ref('')
const customApiKey = ref('')
const customHasKey = ref(false)
const savingCustom = ref(false)

const modelOptions = computed(() =>
  modelConfigs.configs.map((c) => ({ label: c.displayName, value: c.id }))
)

async function onSourceChange(source: 'model' | 'custom'): Promise<void> {
  embeddingSource.value = source
  // 切换来源后按已保存配置回填表单
  const cfg = await mainClient.knowledge.getConfig()
  applyConfig(cfg.embedding)
}

/** 从已保存配置回填当前来源的表单。 */
function applyConfig(
  embedding: Awaited<ReturnType<typeof mainClient.knowledge.getConfig>>['embedding']
): void {
  if (!embedding) {
    selectedConfigId.value = null
    customBaseUrl.value = ''
    customModelId.value = ''
    customHasKey.value = false
    return
  }
  if (embedding.source === 'model') {
    selectedConfigId.value = embedding.configId
  } else {
    customBaseUrl.value = embedding.baseUrl ?? ''
    customModelId.value = embedding.modelId ?? ''
    customHasKey.value = embedding.hasApiKey
  }
}

/** model 模式：选择即保存。 */
async function onModelChange(id: string | null): Promise<void> {
  try {
    await mainClient.knowledge.setConfig({
      embedding: id ? { source: 'model', configId: id } : null
    })
    testResult.value = null
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    const cfg = await mainClient.knowledge.getConfig()
    applyConfig(cfg.embedding)
  }
}

/** custom 模式：保存配置（apiKey 留空 = 沿用已保存的 key）。 */
async function onSaveCustom(): Promise<void> {
  savingCustom.value = true
  try {
    await mainClient.knowledge.setConfig({
      embedding: {
        source: 'custom',
        baseUrl: customBaseUrl.value,
        modelId: customModelId.value,
        apiKey: customApiKey.value.trim() ? customApiKey.value.trim() : undefined
      }
    })
    customHasKey.value = !!customApiKey.value.trim() || customHasKey.value
    customApiKey.value = ''
    testResult.value = null
    message.success('embedding 配置已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingCustom.value = false
  }
}

/** 测试按钮（价格监测）：按当前表单值直接测试，不依赖已保存状态。 */
const testing = ref(false)
const testResult = ref<{ ok: boolean; error?: string; dimension?: number } | null>(null)

async function onTestEmbedding(): Promise<void> {
  const input =
    embeddingSource.value === 'model'
      ? { source: 'model' as const, configId: selectedConfigId.value ?? '' }
      : {
          source: 'custom' as const,
          baseUrl: customBaseUrl.value,
          modelId: customModelId.value,
          apiKey: customApiKey.value.trim() || undefined
        }
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await mainClient.knowledge.testEmbedding(input)
    await loadStats()
  } catch (err) {
    testResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    testing.value = false
  }
}

// ---- 用量（价格监测） ----
const stats = ref<{ calls: number; tokens: number; cost: number }>({ calls: 0, tokens: 0, cost: 0 })

async function loadStats(): Promise<void> {
  stats.value = await mainClient.knowledge.getEmbeddingStats()
}

// ---- 文档管理 ----
const documents = ref<KbDocument[]>([])
const loading = ref(false)
const importing = ref(false)
const reembedding = ref(false)

const statusLabel: Record<KbDocument['status'], string> = {
  indexing: '入库中',
  ready: '就绪',
  error: '失败'
}
const statusType: Record<KbDocument['status'], 'info' | 'success' | 'error'> = {
  indexing: 'info',
  ready: 'success',
  error: 'error'
}

async function loadDocuments(silent = false): Promise<void> {
  if (!silent) loading.value = true
  try {
    documents.value = await mainClient.knowledge.listDocuments()
  } finally {
    if (!silent) loading.value = false
  }
}

// ---- 导入进度轮询 ----
/** 轮询定时器：导入后仍有文档处于 indexing（后台向量化）时定期刷新列表。 */
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(async () => {
    await loadDocuments(true)
    // 全部文档不再处于入库/向量化状态时停止轮询
    if (!documents.value.some((d) => d.status === 'indexing')) {
      stopPolling()
      await loadStats()
    }
  }, 1500)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(stopPolling)

async function onImport(): Promise<void> {
  importing.value = true
  try {
    const r = await mainClient.knowledge.importDocuments()
    const parts: string[] = []
    if (r.imported > 0) parts.push(`导入 ${r.imported} 个`)
    if (r.skipped > 0) parts.push(`跳过重复 ${r.skipped} 个`)
    if (r.failed > 0) parts.push(`失败 ${r.failed} 个`)
    message.success(parts.length > 0 ? parts.join('，') : '已取消导入')
    // 立即刷新列表：新文档以「处理中」状态出现；若后台向量化仍在进行则轮询到完成
    await Promise.all([loadDocuments(), loadStats()])
    if (documents.value.some((d) => d.status === 'indexing')) {
      startPolling()
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    importing.value = false
  }
}

async function onDelete(id: string): Promise<void> {
  await mainClient.knowledge.deleteDocument(id)
  message.success('已删除文档')
  await Promise.all([loadDocuments(), loadStats()])
}

/** 重新嵌入：不传 id 重算全部，传 id 重算单个。 */
async function onReembed(id?: string): Promise<void> {
  reembedding.value = true
  try {
    const r = await mainClient.knowledge.reembedDocuments(id ? [id] : undefined)
    if (r.error) message.error(r.error)
    else message.success(`已重新嵌入 ${r.count} 个文档`)
    await Promise.all([loadDocuments(), loadStats()])
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    reembedding.value = false
  }
}

// ---- 搜索测试 ----
const searchQuery = ref('')
const searchHits = ref<KbSearchHit[]>([])
const searching = ref(false)

async function onSearch(): Promise<void> {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    searchHits.value = await mainClient.knowledge.searchDocuments(q, 8)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    searching.value = false
  }
}

function onClearSearch(): void {
  searchQuery.value = ''
  searchHits.value = []
}

async function onToggleEnabled(v: boolean): Promise<void> {
  await settings.saveKbEnabled(v)
  message.success(v ? '已启用知识库' : '已关闭知识库')
}

/** 更新时间展示（yyyy-MM-dd HH:mm）。 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(async () => {
  if (modelConfigs.configs.length === 0) await modelConfigs.load()
  const cfg = await mainClient.knowledge.getConfig()
  embeddingSource.value = cfg.embedding?.source ?? 'model'
  applyConfig(cfg.embedding)
  await Promise.all([loadDocuments(), loadStats()])
})
</script>

<template>
  <div>
    <!-- 知识库配置 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>知识库</span>
      </template>
      <p class="settings-card__desc">
        导入本地文档（docx / pdf / md / txt 等）后，Agent 可通过 search_knowledge
        检索相关内容并基于文档回答。文档与向量全部保存在本机，不会上传。
        嵌入模型用于文档向量化与语义检索：可直接复用已添加的模型（许多对话模型同样提供嵌入接口），
        或单独配置一个自定义嵌入端点。
      </p>
      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">启用知识库</span>
          <span class="data-row__hint">关闭后 Agent 不再检索知识库</span>
        </div>
        <NSwitch :value="settings.kbEnabled" @update:value="onToggleEnabled" />
      </div>

      <!-- embedding 配置 -->
      <div class="data-row data-row--gap kb-embed">
        <div class="data-row__info">
          <span class="data-row__label">Embedding 模型</span>
          <span class="data-row__hint">选择后立即生效；自定义配置需点击「保存配置」</span>
        </div>
        <NRadioGroup :value="embeddingSource" size="small" @update:value="onSourceChange">
          <NRadioButton value="model">使用已添加模型</NRadioButton>
          <NRadioButton value="custom">自定义配置</NRadioButton>
        </NRadioGroup>
      </div>

      <!-- model 模式：从已添加模型中选择 -->
      <div v-if="embeddingSource === 'model'" class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">模型</span>
          <span class="data-row__hint">
            {{
              modelConfigs.configs.length === 0
                ? '尚未添加模型，请到「模型」页添加'
                : '复用其 Base URL / API Key'
            }}
          </span>
        </div>
        <NSelect
          v-model:value="selectedConfigId"
          :options="modelOptions"
          :disabled="modelConfigs.configs.length === 0"
          placeholder="选择已添加的模型"
          clearable
          style="width: 220px"
          size="small"
          @update:value="onModelChange"
        />
      </div>

      <!-- custom 模式：知识库专属配置 -->
      <div v-else class="kb-custom">
        <div class="kb-custom__row">
          <label class="kb-custom__label">Base URL</label>
          <NInput
            v-model:value="customBaseUrl"
            placeholder="https://api.example.com/v1"
            size="small"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="kb-custom__row">
          <label class="kb-custom__label">模型 ID</label>
          <NInput
            v-model:value="customModelId"
            placeholder="如 text-embedding-3-small"
            size="small"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="kb-custom__row">
          <label class="kb-custom__label">API Key</label>
          <NInput
            v-model:value="customApiKey"
            type="password"
            show-password-on="click"
            size="small"
            :placeholder="customHasKey ? '已配置（留空保持不变）' : '本地端点（如 Ollama）可留空'"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="kb-custom__actions">
          <NButton size="small" :loading="savingCustom" @click="onSaveCustom">保存配置</NButton>
          <span class="kb-custom__hint"
            >Key 经系统安全存储加密；本地无鉴权端点（如 Ollama）可留空</span
          >
        </div>
      </div>

      <!-- 测试按钮（价格监测） -->
      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">连通性测试</span>
          <span class="data-row__hint">发送最小请求验证当前配置可用，并显示向量维度</span>
        </div>
        <NButton size="small" tertiary :loading="testing" @click="onTestEmbedding">测试</NButton>
      </div>
      <NAlert
        v-if="testResult"
        :type="testResult.ok ? 'success' : 'error'"
        :show-icon="true"
        size="small"
        class="kb-alert"
      >
        {{
          testResult.ok
            ? `连接成功，向量维度 ${testResult.dimension}`
            : `测试失败：${testResult.error ?? '未知错误'}`
        }}
      </NAlert>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">嵌入用量与费用</span>
          <span class="data-row__hint">累计 embedding 调用成本（含文档向量化与查询）</span>
        </div>
        <span class="kb-stats">
          {{ stats.calls }} 次 · {{ formatTokens(stats.tokens) }} tokens · 费用
          {{ formatCost(stats.cost) }}
        </span>
      </div>
    </NCard>

    <!-- 知识库工具开关 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>知识库工具</span>
      </template>
      <p class="settings-card__desc">
        控制 Agent
        可调用的知识库检索工具（search_knowledge）。知识库总开关关闭时此处不可调整，恢复后按原状态生效。修改后对当前会话下一轮生效。
      </p>
      <ToolSwitches :tools="kbTools" :disabled="!settings.kbEnabled" />
    </NCard>

    <!-- 文档管理 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>文档管理</span>
      </template>
      <template #header-extra>
        <NSpace :size="8" align="center">
          <NTag size="small" round>{{ documents.length }} 个文档</NTag>
          <NButton
            v-if="documents.length > 0"
            size="tiny"
            tertiary
            :loading="reembedding"
            :disabled="documents.some((d) => d.status === 'indexing')"
            @click="onReembed()"
          >
            全部重新嵌入
          </NButton>
        </NSpace>
      </template>
      <p class="settings-card__desc">
        导入后会解析并切片，配置了 embedding 模型时自动向量化；未配置时仍可按关键词检索。
      </p>

      <div v-if="loading" class="kb-empty">加载中…</div>
      <div v-else-if="documents.length === 0" class="kb-empty">
        暂无文档。点击下方「导入文档」添加 docx、pdf、md、txt 等文件。
      </div>
      <div v-else class="kb-list">
        <div v-for="d in documents" :key="d.id" class="kb-item">
          <div class="kb-item__main">
            <div class="kb-item__head">
              <span class="kb-item__title">{{ d.title }}</span>
              <NTag :type="statusType[d.status]" size="tiny" round>
                {{ statusLabel[d.status] }}
              </NTag>
              <NTag v-if="d.embeddingModel" type="info" size="tiny" round>已嵌入</NTag>
            </div>
            <div class="kb-item__meta">
              <span>{{ d.fileName }}</span>
              <span>· {{ d.chunkCount }} 个切片</span>
              <span>· {{ formatTime(d.createdAt) }}</span>
            </div>
            <p v-if="d.status === 'error' && d.error" class="kb-item__error">{{ d.error }}</p>
          </div>
          <NSpace :size="8" align="center">
            <NButton
              size="tiny"
              tertiary
              :loading="reembedding"
              :disabled="d.status === 'indexing'"
              @click="onReembed(d.id)"
            >
              重新嵌入
            </NButton>
            <NPopconfirm @positive-click="onDelete(d.id)">
              <template #trigger>
                <NButton size="tiny" tertiary type="error">删除</NButton>
              </template>
              将删除「{{ d.title }}」的切片与本地源文件，确定吗？
            </NPopconfirm>
          </NSpace>
          <!-- 处理中：后台向量化进行中，底部显示流动动画 -->
          <div v-if="d.status === 'indexing'" class="kb-item__progress">
            <div class="kb-item__progress-bar" />
          </div>
        </div>
      </div>

      <div class="kb-import">
        <NButton type="primary" :loading="importing" @click="onImport">导入文档</NButton>
      </div>
    </NCard>

    <!-- 搜索测试 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>搜索测试</span>
      </template>
      <p class="settings-card__desc">
        与 Agent 的检索路径一致，可预览当前知识库对某个问题的召回结果。
      </p>
      <div class="kb-search">
        <NInput
          v-model:value="searchQuery"
          placeholder="输入问题或关键词，回车检索…"
          size="small"
          clearable
          @keyup.enter="onSearch"
        />
        <NButton size="small" type="primary" :loading="searching" @click="onSearch">检索</NButton>
        <NButton v-if="searchHits.length > 0" size="small" tertiary @click="onClearSearch">
          清空
        </NButton>
      </div>
      <div v-if="searchHits.length > 0" class="kb-search__hits">
        <div v-for="h in searchHits" :key="h.chunkId" class="kb-search__hit">
          <div class="kb-search__hit-head">
            <NTag size="tiny" round>{{ h.docTitle }}</NTag>
            <span v-if="h.title" class="kb-search__hit-title">{{ h.title }}</span>
            <span class="kb-search__hit-score">相关度 {{ h.score.toFixed(4) }}</span>
          </div>
          <p class="kb-search__hit-content">{{ h.content }}</p>
        </div>
      </div>
      <div v-else-if="searchQuery.trim() && !searching" class="kb-empty">无匹配结果</div>
    </NCard>
  </div>
</template>

<style scoped>
.settings-card {
  margin-bottom: 16px;
}
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.data-row--gap {
  margin-top: 8px;
}
.data-row__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-right: 12px;
}
.data-row__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.data-row__hint {
  font-size: 12px;
  color: var(--text-3);
}
.kb-alert {
  margin-top: 8px;
}
.kb-stats {
  font-size: 13px;
  color: var(--text-1);
  white-space: nowrap;
}

/* 自定义配置表单 */
.kb-custom {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-custom__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.kb-custom__label {
  width: 72px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.kb-custom__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.kb-custom__hint {
  font-size: 11px;
  color: var(--text-3);
}

/* 文档列表 */
.kb-empty {
  margin-top: 12px;
  padding: 20px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.kb-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kb-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  position: relative;
  overflow: hidden;
}
.kb-item__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  overflow: hidden;
}
.kb-item__progress-bar {
  width: 40%;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--primary, #2080f0), transparent);
  animation: kb-progress-flow 1.2s ease-in-out infinite;
}
@keyframes kb-progress-flow {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(350%);
  }
}
.kb-item__main {
  flex: 1;
  min-width: 0;
}
.kb-item__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}
.kb-item__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.kb-item__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
}
.kb-item__error {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--error, #d03050);
  word-break: break-all;
}
.kb-import {
  margin-top: 12px;
}

/* 搜索测试 */
.kb-search {
  display: flex;
  gap: 8px;
  align-items: center;
}
.kb-search__hits {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 4px;
}
.kb-search__hit {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.kb-search__hit-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.kb-search__hit-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.kb-search__hit-score {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}
.kb-search__hit-content {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  word-break: break-word;
  white-space: pre-wrap;
}
</style>
