<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NPopconfirm, NSpace, NTag, useMessage } from 'naive-ui'
import { mainClient } from '@renderer/utils/main-client'
import { useWindowStore } from '@renderer/store/useWindowStore'
import type { WorkspaceWithStats } from '@main/database'

const message = useMessage()
const windowStore = useWindowStore()

/** 工作区列表。 */
const workspaces = ref<WorkspaceWithStats[]>([])
/** 正在编辑 agent.md 的工作区（null = 未选择）。 */
const editingWorkdir = ref<string | null>(null)
/** agent.md 草稿。 */
const mdDraft = ref('')
/** 重命名输入（弹行内输入）。 */
const renamingWorkdir = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null)

/** 正在编辑 agent.md 的工作区对象（编辑器头部展示归属）。 */
const editingWorkspace = computed(() =>
  workspaces.value.find((w) => w.workdir === editingWorkdir.value)
)

async function load(): Promise<void> {
  workspaces.value = await mainClient.workspace.list()
}

async function onCreate(): Promise<void> {
  const ws = await mainClient.workspace.pickAndCreate()
  if (!ws) return
  message.success(`已创建工作区「${ws.name}」并打开窗口`)
  await load()
}

async function onOpen(workdir: string): Promise<void> {
  await mainClient.workspace.open(workdir)
}

async function onRemove(workdir: string): Promise<void> {
  const ws = workspaces.value.find((w) => w.workdir === workdir)
  await mainClient.workspace.remove(workdir)
  if (editingWorkdir.value === workdir) editingWorkdir.value = null
  message.success(`已删除工作区「${ws?.name ?? workdir}」及其全部会话`)
  await load()
}

function startRename(ws: WorkspaceWithStats): void {
  renamingWorkdir.value = ws.workdir
  renameDraft.value = ws.name
}

/** 保存重命名（Enter / 失焦触发）。空标题或未在编辑态直接忽略。 */
async function confirmRename(): Promise<void> {
  const workdir = renamingWorkdir.value
  if (!workdir) return
  // 先退出编辑态再提交：失焦保存与点击其他按钮（blur 后 click）互不干扰
  renamingWorkdir.value = null
  const v = renameDraft.value.trim()
  if (!v || v === workspaces.value.find((w) => w.workdir === workdir)?.name) return
  await mainClient.workspace.rename(workdir, v)
  message.success('已重命名')
  await load()
}

// 进入重命名态后聚焦输入框并全选，便于直接覆盖原名
watch(renamingWorkdir, async (workdir) => {
  if (workdir) {
    await nextTick()
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  }
})

/** 选中工作区 → 加载其 agent.md（项目记忆编辑器）。 */
async function selectForEdit(workdir: string): Promise<void> {
  editingWorkdir.value = workdir
  const content = await mainClient.workspace.getAgentMd(workdir)
  mdDraft.value = content ?? ''
}

async function saveAgentMd(): Promise<void> {
  if (!editingWorkdir.value) return
  await mainClient.workspace.saveAgentMd(editingWorkdir.value, mdDraft.value)
  message.success('agent.md 已保存（新会话生效）')
}

watch(editingWorkdir, () => {
  // 切换工作区时丢弃未保存草稿
  if (!editingWorkdir.value) mdDraft.value = ''
})

onMounted(load)
</script>

<template>
  <div class="workspace-panel">
    <NButton type="primary" @click="onCreate">新建工作区</NButton>

    <div v-if="workspaces.length === 0" class="workspace-panel__empty">
      <p>暂无工作区。点击上方「新建工作区」，选择一个项目目录即可创建专属窗口与会话。</p>
    </div>

    <div v-else class="workspace-list">
      <div v-for="ws in workspaces" :key="ws.workdir" class="workspace-item">
        <!-- 头部：名称（或重命名输入框）+ 会话数 -->
        <div class="workspace-item__head">
          <div class="workspace-item__title">
            <NInput
              v-if="renamingWorkdir === ws.workdir"
              ref="renameInputRef"
              v-model:value="renameDraft"
              size="small"
              class="workspace-item__rename-input"
              :placeholder="ws.name"
              maxlength="60"
              spellcheck="false"
              @keyup.enter="confirmRename"
              @blur="confirmRename"
            />
            <template v-else>
              <span class="workspace-item__name" :title="ws.name">{{ ws.name }}</span>
              <NTag
                v-if="ws.workdir === windowStore.state.workdir"
                type="success"
                size="tiny"
                round
              >
                当前窗口
              </NTag>
            </template>
          </div>
          <span class="workspace-item__meta">{{ ws.sessionCount }} 个会话</span>
        </div>

        <code class="workspace-item__path" :title="ws.workdir">{{ ws.workdir }}</code>

        <!-- 操作行：固定高度，按钮不换行不错位 -->
        <div class="workspace-item__actions">
          <NButton size="small" tertiary @click="onOpen(ws.workdir)">打开窗口</NButton>
          <NButton
            size="small"
            tertiary
            :type="editingWorkdir === ws.workdir ? 'primary' : 'default'"
            @click="selectForEdit(ws.workdir)"
          >
            agent.md
          </NButton>
          <NButton
            size="small"
            tertiary
            :disabled="renamingWorkdir === ws.workdir"
            @click="startRename(ws)"
          >
            重命名
          </NButton>
          <NPopconfirm :disabled="workspaces.length <= 1" @positive-click="onRemove(ws.workdir)">
            <template #trigger>
              <NButton
                size="small"
                tertiary
                type="error"
                :disabled="workspaces.length <= 1"
                :title="workspaces.length <= 1 ? '至少保留一个工作区' : undefined"
              >
                删除
              </NButton>
            </template>
            将删除工作区「{{ ws.name }}」及其全部
            {{ ws.sessionCount }} 个会话（消息无法恢复）。确定吗？
          </NPopconfirm>
        </div>
      </div>
    </div>

    <!-- agent.md 项目记忆编辑器：头部明确展示正在编辑的工作区 -->
    <div v-if="editingWorkdir" class="workspace-panel__editor">
      <div class="workspace-panel__editor-head">
        <span class="workspace-panel__editor-title">
          项目记忆（agent.md）
          <template v-if="editingWorkspace">
            <NTag size="small" round class="workspace-panel__editor-ws">
              {{ editingWorkspace.name }}
            </NTag>
          </template>
        </span>
        <NSpace :size="8">
          <NButton size="small" tertiary @click="editingWorkdir = null">收起</NButton>
          <NButton size="small" type="primary" @click="saveAgentMd">保存</NButton>
        </NSpace>
      </div>
      <code class="workspace-panel__editor-path" :title="editingWorkdir ?? undefined">
        {{ editingWorkdir }}
      </code>
      <p class="workspace-panel__hint">
        作为该工作区的项目记忆注入系统提示词（按注入上限截断）。保持精炼，记录项目概述、技术栈、约定与进展；详细文档放在项目内由
        Agent 按需读取。
      </p>
      <NInput
        v-model:value="mdDraft"
        type="textarea"
        :rows="12"
        placeholder="# 项目概述&#10;&#10;记录本项目的目的、技术栈、目录结构、约定与当前进展…"
        spellcheck="false"
      />
    </div>
  </div>
</template>

<style scoped>
.workspace-panel__empty {
  margin-top: 16px;
  padding: 20px 12px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.workspace-panel__empty p {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}
.workspace-list {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 工作区卡片：头部 + 路径 + 操作行纵向堆叠，各卡片高度一致、按钮不挤压 */
.workspace-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.workspace-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.workspace-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.workspace-item__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-item__rename-input {
  width: 100%;
  max-width: 320px;
}
.workspace-item__meta {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}
.workspace-item__path {
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
.workspace-item__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.workspace-panel__editor {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.workspace-panel__editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}
.workspace-panel__editor-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
}
.workspace-panel__editor-ws {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.workspace-panel__editor-path {
  display: block;
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
.workspace-panel__hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
</style>
