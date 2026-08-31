<script setup lang="ts">
import { ref } from 'vue'
import { NCard, NTag, NButton, NPopconfirm, NSpace, useMessage } from 'naive-ui'
import AddModelDialog from './AddModelDialog.vue'
import SystemPromptEditor from './SystemPromptEditor.vue'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { formatContextWindow } from '@renderer/utils/format'
import type { ModelConfigSummary } from '@main/agent/types'

const modelConfigs = useModelConfigsStore()
const settings = useSettingsStore()
const message = useMessage()

/** AddModelDialog 显示状态与编辑目标。 */
const dialogShow = ref(false)
const editing = ref<ModelConfigSummary | null>(null)

/** 系统提示保存中（独立于 API key 的 saving）。 */
const promptSaving = ref(false)

function onAdd(): void {
  editing.value = null
  dialogShow.value = true
}

function onEdit(config: ModelConfigSummary): void {
  editing.value = config
  dialogShow.value = true
}

async function onRemove(config: ModelConfigSummary): Promise<void> {
  await modelConfigs.remove(config.id)
  message.success(`已删除：${config.displayName}`)
}

/** 模型来源摘要文案。 */
function sourceLabel(c: ModelConfigSummary): string {
  return c.source === 'preset' ? (c.presetProvider ?? '预置') : '自定义'
}

async function onPromptSave(value: string): Promise<void> {
  promptSaving.value = true
  try {
    await settings.saveDefaultSystemPrompt(value)
    message.success('系统提示已更新')
  } finally {
    promptSaving.value = false
  }
}
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>模型</span>
      </template>
      <template #header-extra>
        <NTag :type="modelConfigs.hasModel ? 'success' : 'warning'" size="small" round>
          {{ modelConfigs.hasModel ? `${modelConfigs.configs.length} 个` : '未添加' }}
        </NTag>
      </template>
      <p class="settings-card__desc">
        添加和管理模型。支持预置服务商或完全自定义（本地地址 / OpenAI
        兼容端点等）。每个模型独立配置 API Key 与参数，可添加多个、可同一服务商多条。Key
        通过系统安全存储加密保存，不会离开本机。
      </p>

      <!-- 空状态 -->
      <div v-if="modelConfigs.configs.length === 0" class="model-empty">
        <p class="model-empty__text">尚未添加模型，点击下方添加一个即可开始对话。</p>
      </div>

      <!-- 已添加模型列表 -->
      <div v-else class="model-list">
        <div v-for="c in modelConfigs.configs" :key="c.id" class="model-list__item">
          <div class="model-list__head">
            <div class="model-list__info">
              <span class="model-list__name">{{ c.displayName }}</span>
              <NTag size="tiny" round>{{ sourceLabel(c) }}</NTag>
              <NTag v-if="c.multimodal" type="info" size="tiny" round>多模态</NTag>
              <NTag v-if="c.reasoning" type="info" size="tiny" round>推理</NTag>
            </div>
            <NSpace :size="8" align="center">
              <NButton size="small" tertiary @click="onEdit(c)">编辑</NButton>
              <NPopconfirm @positive-click="onRemove(c)">
                <template #trigger>
                  <NButton size="small" tertiary type="error">删除</NButton>
                </template>
                确定要删除「{{ c.displayName }}」吗？此操作不可撤销。
              </NPopconfirm>
            </NSpace>
          </div>
          <div class="model-list__meta">
            <span>{{ c.modelId }}</span>
            <span>· {{ formatContextWindow(c.contextWindow) }} 上下文</span>
            <span>· {{ formatContextWindow(c.maxTokens) }} 输出</span>
            <NTag :type="c.hasApiKey ? 'success' : 'warning'" size="tiny" round>
              {{ c.hasApiKey ? '已配置 Key' : '未配置 Key' }}
            </NTag>
          </div>
        </div>
      </div>

      <div class="model-add">
        <NButton type="primary" @click="onAdd">添加模型</NButton>
      </div>
    </NCard>

    <NCard size="small" class="settings-card">
      <template #header>
        <span>默认系统提示</span>
      </template>
      <p class="settings-card__desc">
        定义 Agent 的角色与行为。留空则使用内置默认提示词。修改后对当前会话下一轮生效。
      </p>
      <SystemPromptEditor
        :model-value="settings.defaultSystemPrompt"
        :saving="promptSaving"
        @save="onPromptSave"
      />
    </NCard>

    <!-- 添加 / 编辑模型对话框 -->
    <AddModelDialog v-model:show="dialogShow" :editing="editing" />
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

/* 模型列表 */
.model-empty {
  padding: 20px 12px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  margin-bottom: 12px;
}
.model-empty__text {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}
.model-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.model-list__item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.model-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.model-list__info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.model-list__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.model-list__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
}
.model-add {
  margin-top: 12px;
}
</style>
