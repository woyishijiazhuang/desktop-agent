<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NCard,
  NButton,
  NTag,
  NPopconfirm,
  NInput,
  NSelect,
  NSwitch,
  NSpace,
  NModal,
  useMessage
} from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import type { Memory, MemoryCategory } from '@main/service/db-service'
import ToolSwitches from './ToolSwitches.vue'

/** 记忆域工具：Agent 通过它们读写长期记忆。 */
const MEMORY_TOOLS = new Set(['list_memories', 'add_memory', 'update_memory', 'delete_memory'])

const settings = useSettingsStore()
const message = useMessage()

/** 记忆工具开关列表。 */
const memoryTools = computed(() => settings.tools.filter((t) => MEMORY_TOOLS.has(t.name)))

/** 记忆分类可选项。 */
const CATEGORY_OPTIONS: { label: string; value: MemoryCategory }[] = [
  { label: '通用', value: 'general' },
  { label: '偏好', value: 'preference' },
  { label: '事实', value: 'fact' },
  { label: '项目', value: 'project' }
]

/** 记忆列表（搜索为空时显示全部）。 */
const memories = ref<Memory[]>([])
const searchQuery = ref('')
const loading = ref(false)

/** 新增表单。 */
const addContent = ref('')
const addCategory = ref<MemoryCategory>('general')

/** 编辑弹窗。 */
const editShow = ref(false)
const editTarget = ref<Memory | null>(null)
const editContent = ref('')
const editCategory = ref<MemoryCategory>('general')

/** 单条记忆字数上限（须与 main 侧 MEMORY_MAX_ENTRY_CHARS=500 一致；配合 NInput show-count 展示计数）。 */
const MAX_MEMORY_CHARS = 500

async function load(): Promise<void> {
  loading.value = true
  try {
    const q = searchQuery.value.trim()
    memories.value = q
      ? await mainClient.db.searchMemories(q, 100)
      : await mainClient.db.listMemories()
  } finally {
    loading.value = false
  }
}

async function onSearch(): Promise<void> {
  await load()
}

async function onAdd(): Promise<void> {
  const content = addContent.value.trim()
  if (!content) {
    message.warning('请输入记忆内容')
    return
  }
  try {
    await mainClient.db.addMemory({ content, category: addCategory.value })
    addContent.value = ''
    message.success('已添加记忆')
    await load()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function onEdit(m: Memory): void {
  editTarget.value = m
  editContent.value = m.content
  editCategory.value = m.category
  editShow.value = true
}

async function onSaveEdit(): Promise<void> {
  const target = editTarget.value
  if (!target) return
  const content = editContent.value.trim()
  if (!content) {
    message.warning('记忆内容不能为空')
    return
  }
  try {
    await mainClient.db.updateMemory(target.id, { content, category: editCategory.value })
    editShow.value = false
    message.success('已更新记忆')
    await load()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function onDelete(id: string): Promise<void> {
  await mainClient.db.deleteMemory(id)
  message.success('已删除记忆')
  await load()
}

async function onClearAll(): Promise<void> {
  const count = await mainClient.db.deleteAllMemories()
  message.success(`已清空 ${count} 条记忆`)
  await load()
}

async function onToggleEnabled(v: boolean): Promise<void> {
  await settings.saveMemoryEnabled(v)
  message.success(v ? '已启用长期记忆' : '已关闭长期记忆')
}

/** 更新时间展示（yyyy-MM-dd HH:mm）。 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(load)
</script>

<template>
  <div>
    <!-- 记忆开关与说明 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>记忆</span>
      </template>
      <p class="settings-card__desc">
        长期记忆会在所有会话中保留关于你的事实与偏好（总量上限 30 条 / 3000 字，超限将拒绝写入）。
        记忆在会话首次创建时随系统提示词全量注入并保持不变；新增或编辑后的记忆仅对尚未创建的会话生效（当前会话内的
        Agent 可通过记忆工具实时查看）。 可直接在下方手动添加、编辑或删除记忆条目。
      </p>
      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">启用长期记忆</span>
          <span class="data-row__hint">控制记忆读写工具是否可用；已注入的记忆不受影响</span>
        </div>
        <NSwitch :value="settings.memoryEnabled" @update:value="onToggleEnabled" />
      </div>
    </NCard>

    <!-- 记忆工具开关 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>记忆工具</span>
      </template>
      <p class="settings-card__desc">
        控制 Agent
        可调用的记忆管理工具（查看、添加、更新、删除记忆条目）。记忆总开关关闭时此处不可调整，恢复后按原状态生效。修改后对当前会话下一轮生效。
      </p>
      <ToolSwitches :tools="memoryTools" :disabled="!settings.memoryEnabled" />
    </NCard>

    <!-- 新增记忆 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>添加记忆</span>
      </template>
      <div class="memory-add">
        <NInput
          v-model:value="addContent"
          type="textarea"
          :rows="2"
          :maxlength="MAX_MEMORY_CHARS"
          show-count
          placeholder="输入需要长期记住的信息，例如「用户是后端开发者，偏好 Python 与简洁代码风格」"
        />
        <div class="memory-add__footer">
          <NSelect
            v-model:value="addCategory"
            :options="CATEGORY_OPTIONS"
            style="width: 140px"
            size="small"
          />
          <NButton size="small" type="primary" @click="onAdd">添加</NButton>
        </div>
      </div>
    </NCard>

    <!-- 记忆列表 -->
    <NCard size="small" class="settings-card">
      <template #header>
        <span>记忆列表</span>
      </template>
      <template #header-extra>
        <NSpace :size="8" align="center">
          <NTag size="small" round>{{ memories.length }} 条</NTag>
          <NPopconfirm @positive-click="onClearAll">
            <template #trigger>
              <NButton size="tiny" tertiary type="error">清空全部</NButton>
            </template>
            将删除全部 {{ memories.length }} 条记忆，此操作不可撤销。确定吗？
          </NPopconfirm>
        </NSpace>
      </template>

      <NInput
        v-model:value="searchQuery"
        placeholder="搜索记忆内容…（回车搜索）"
        size="small"
        clearable
        @keyup.enter="onSearch"
        @clear="load"
      />

      <div v-if="loading" class="memory-empty">加载中…</div>
      <div v-else-if="memories.length === 0" class="memory-empty">
        暂无记忆条目。可以点击上方「添加记忆」，或直接告诉 Agent「记住…」，由它调用记忆工具保存。
      </div>
      <div v-else class="memory-list">
        <div v-for="m in memories" :key="m.id" class="memory-item">
          <div class="memory-item__main">
            <p class="memory-item__content">{{ m.content }}</p>
            <div class="memory-item__meta">
              <NTag :type="m.source === 'manual' ? 'success' : 'info'" size="tiny" round>
                {{ m.source === 'manual' ? '手动' : '自动' }}
              </NTag>
              <NTag size="tiny" round>
                {{ CATEGORY_OPTIONS.find((c) => c.value === m.category)?.label ?? m.category }}
              </NTag>
              <span class="memory-item__time">{{ formatTime(m.updatedAt) }}</span>
            </div>
          </div>
          <NSpace :size="8" align="center">
            <NButton size="tiny" tertiary @click="onEdit(m)">编辑</NButton>
            <NPopconfirm @positive-click="onDelete(m.id)">
              <template #trigger>
                <NButton size="tiny" tertiary type="error">删除</NButton>
              </template>
              确定删除这条记忆吗？
            </NPopconfirm>
          </NSpace>
        </div>
      </div>
    </NCard>

    <!-- 编辑弹窗 -->
    <NModal
      :show="editShow"
      preset="card"
      title="编辑记忆"
      :style="{ width: '480px', maxWidth: 'calc(100vw - 48px)' }"
      @update:show="(v: boolean) => (editShow = v)"
    >
      <div class="memory-edit">
        <NInput
          v-model:value="editContent"
          type="textarea"
          :rows="4"
          :maxlength="MAX_MEMORY_CHARS"
          show-count
          placeholder="记忆内容"
        />
        <NSelect
          v-model:value="editCategory"
          :options="CATEGORY_OPTIONS"
          style="width: 140px"
          size="small"
        />
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="editShow = false">取消</NButton>
          <NButton size="small" type="primary" @click="onSaveEdit">保存</NButton>
        </NSpace>
      </template>
    </NModal>
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

/* 新增记忆 */
.memory-add__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}

/* 记忆列表 */
.memory-empty {
  margin-top: 12px;
  padding: 20px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--text-3);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.memory-list {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.memory-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.memory-item__main {
  flex: 1;
  min-width: 0;
}
.memory-item__content {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-1);
  word-break: break-word;
  white-space: pre-wrap;
}
.memory-item__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.memory-item__time {
  font-size: 11px;
  color: var(--text-3);
}

/* 编辑弹窗 */
.memory-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
