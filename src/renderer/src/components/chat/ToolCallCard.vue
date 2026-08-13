<script setup lang="ts">
import { computed, ref } from 'vue'
import { NCode, NTag, NButton, NIcon } from 'naive-ui'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  HelpCircleOutline,
  SyncOutline,
  CodeSlashOutline,
  CopyOutline,
  ChevronDownOutline,
  ChevronUpOutline
} from '@vicons/ionicons5'
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ToolStatus } from '@renderer/store/useChatStore'
import { useCopy } from '@renderer/composables/useCopy'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'
import hljs, { tryPrettyJSON } from '@renderer/utils/highlight'
import { summarizeToolArgs, summarizeToolResult } from '@renderer/utils/toolResult'
import { extractMessageText } from '@renderer/utils/messageText'

/**
 * 工具调用卡片：展示 toolCall 的意图（reason）/ 参数 / 执行状态 / 执行结果。
 * - 状态来自 useChatStore.toolStatus（tool_execution_start/end 事件驱动；权限确认中为 pending）。
 * - 结果来自匹配到的 toolResult 消息（MessageList 按 toolCallId 传入）。
 * 收起时头部即展示「工具名 + AI 一句话说明 + 结果摘要」，无需展开即可浏览；
 * 展开后分「参数」「结果」两个区块查看详情。
 * 权限确认的决策入口在输入框上方的批量条（PermissionBar），卡片仅展示「等待确认」状态。
 */
const props = defineProps<{
  toolCall: ToolCall
  status?: ToolStatus
  result?: ToolResultMessage
}>()

const { copy } = useCopy()
const pauseStick = useStickToBottomPause()

/** AI 在 reason 参数中写的一句话说明；缺失时从关键参数兜底推导（历史消息 / 未填写的模型）。 */
const reason = computed(() => {
  const r = props.toolCall.arguments?.reason
  if (typeof r === 'string' && r.trim()) return r.trim()
  return summarizeToolArgs(props.toolCall.name, props.toolCall.arguments)
})

/** 参数区是否可展示（剔除 reason 后仍有其它参数）。 */
const hasArgs = computed(() => {
  const args = props.toolCall.arguments
  if (!args) return false
  return Object.keys(args).some((k) => k !== 'reason')
})

const argsText = computed(() => {
  const args = props.toolCall.arguments
  if (!args) return ''
  // 剔除 reason（仅展示给用户、非执行参数），避免参数区出现冗余
  const rest = { ...args }
  delete rest.reason
  return JSON.stringify(rest, null, 2)
})

/** 匹配到的工具结果（toolResult 消息）。 */
const hasResult = computed(
  () => !!props.result && extractMessageText(props.result.content).length > 0
)
const resultText = computed(() => (props.result ? extractMessageText(props.result.content) : ''))
const resultDisplay = computed(() => {
  const pretty = tryPrettyJSON(resultText.value)
  if (pretty !== null) return { text: pretty, language: 'json' as string | null }
  return { text: resultText.value, language: null as string | null }
})
/** 结果摘要：卡片收起时也可见的一行文案（含失败信息）。 */
const resultSummary = computed(() => (props.result ? summarizeToolResult(props.result) : null))

const statusLabel = computed(() => {
  if (!props.status) return '待执行'
  const map: Record<ToolStatus['status'], string> = {
    pending: '等待确认',
    running: '执行中…',
    completed: '已完成',
    error: '出错'
  }
  return map[props.status.status]
})

const statusType = computed<'default' | 'warning' | 'success' | 'error'>(() => {
  if (!props.status) return 'default'
  const map: Record<ToolStatus['status'], 'default' | 'warning' | 'success' | 'error'> = {
    pending: 'warning',
    running: 'warning',
    completed: 'success',
    error: 'error'
  }
  return map[props.status.status]
})

/** 头部状态图标：pending 问号、running 转圈、completed 完成、error 出错、待执行 用工具图标。 */
const statusIcon = computed(() => {
  if (!props.status) return CodeSlashOutline
  if (props.status.status === 'pending') return HelpCircleOutline
  if (props.status.status === 'running') return SyncOutline
  if (props.status.status === 'completed') return CheckmarkCircleOutline
  return CloseCircleOutline
})

const statusIconColor = computed(() => {
  if (!props.status) return 'var(--text-3)'
  if (props.status.status === 'pending') return 'var(--warning)'
  if (props.status.status === 'running') return 'var(--warning)'
  if (props.status.status === 'completed') return 'var(--success)'
  return 'var(--error)'
})

const spinning = computed(() => !!props.status && props.status.status === 'running')

/** 详情默认折叠（仅保留头部意图 + 结果摘要），点击头部展开「参数 / 结果」。 */
const expanded = ref(false)
/** 代码是否已渲染过：首次展开前不渲染 NCode（懒渲染），
  避免折叠时仍做 JSON 序列化 + 语法高亮；渲染后保留在 DOM。 */
const codeRendered = ref(false)
const canExpand = computed(() => hasArgs.value || hasResult.value)

function toggleExpand(): void {
  if (canExpand.value) {
    // 切换前解除粘底锁定，避免 vue-stick-to-bottom 把展开高度变化当作流式增长强制滚底而闪烁
    pauseStick?.()
    expanded.value = !expanded.value
    if (expanded.value) codeRendered.value = true
  }
}

function onCopyArgs(): void {
  void copy(argsText.value, '参数')
}

function onCopyResult(): void {
  void copy(resultText.value, '结果')
}
</script>

<template>
  <div class="tool-card">
    <div
      class="tool-card__head"
      :class="{ 'tool-card__head--clickable': canExpand }"
      @click="toggleExpand"
    >
      <div class="tool-card__head-main">
        <span class="tool-card__title">
          <NIcon :color="statusIconColor" :size="15" :class="{ 'tool-card__icon--spin': spinning }">
            <component :is="statusIcon" />
          </NIcon>
          <span class="tool-card__name">{{ toolCall.name }}</span>
          <span v-if="reason" class="tool-card__reason">{{ reason }}</span>
          <NTag :type="statusType" size="tiny" round>{{ statusLabel }}</NTag>
        </span>
        <span
          v-if="resultSummary"
          class="tool-card__summary"
          :class="`tool-card__summary--${resultSummary.tone}`"
        >
          {{ resultSummary.text }}
        </span>
      </div>
      <span class="tool-card__extra">
        <NIcon v-if="canExpand" class="tool-card__chevron" :size="14" title="展开/收起详情">
          <ChevronUpOutline v-if="expanded" />
          <ChevronDownOutline v-else />
        </NIcon>
      </span>
    </div>

    <div
      v-if="canExpand"
      class="tool-card__body"
      :class="{ 'tool-card__body--collapsed': !expanded }"
    >
      <div v-if="hasArgs" class="tool-card__section">
        <div class="tool-card__section-head">
          <span class="tool-card__section-label">参数</span>
          <NButton
            quaternary
            size="tiny"
            :focusable="false"
            title="复制参数"
            @click.stop="onCopyArgs"
          >
            <template #icon>
              <NIcon><CopyOutline /></NIcon>
            </template>
          </NButton>
        </div>
        <NCode
          v-if="codeRendered"
          :code="argsText"
          :hljs="hljs"
          language="json"
          :word-wrap="true"
          class="tool-card__code"
        />
      </div>

      <div v-if="hasResult" class="tool-card__section">
        <div class="tool-card__section-head">
          <span class="tool-card__section-label">结果</span>
          <NButton
            quaternary
            size="tiny"
            :focusable="false"
            title="复制结果"
            @click.stop="onCopyResult"
          >
            <template #icon>
              <NIcon><CopyOutline /></NIcon>
            </template>
          </NButton>
        </div>
        <NCode
          v-if="codeRendered"
          :code="resultDisplay.text"
          :hljs="hljs"
          :language="resultDisplay.language ?? undefined"
          :word-wrap="true"
          class="tool-card__code"
        />
      </div>

      <div v-else-if="props.result" class="tool-card__section">
        <div class="tool-card__section-head">
          <span class="tool-card__section-label">结果</span>
        </div>
        <div class="tool-card__empty">（无输出）</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  overflow: hidden;
  max-width: var(--msg-max-width);
  width: fit-content;
  min-width: 200px;
}
.tool-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
}
.tool-card__head--clickable {
  cursor: pointer;
}
.tool-card__head--clickable:hover {
  background: var(--hover-bg);
}
.tool-card__head-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tool-card__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.tool-card__name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  white-space: nowrap;
}
/* AI 一句话说明（reason）：与工具名区分使用普通字体、弱化颜色、可截断 */
.tool-card__reason {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 420px;
}
/* 结果摘要：收起时也可见的「工具干了什么」一行文案 */
.tool-card__summary {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-card__summary--success {
  color: var(--success);
}
.tool-card__summary--error {
  color: var(--error);
}
.tool-card__icon--spin {
  animation: tool-card-spin 1s linear infinite;
}
@keyframes tool-card-spin {
  to {
    transform: rotate(360deg);
  }
}
.tool-card__extra {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.tool-card__chevron {
  color: var(--text-3);
}
.tool-card__body {
  border-top: 1px solid var(--border-soft);
  background: var(--code-bg);
  max-height: 420px;
  overflow: auto;
  /* 始终为滚动条预留 gutter，避免滚动条出现/消失时文字宽度变化导致重排。 */
  scrollbar-gutter: stable;
  /* padding 统一收拢到此处，作为唯一边距来源；
     NCode 自带 padding 由下方 :deep 清零，避免双倍边距。 */
  padding: 10px 12px;
  transition:
    max-height 0.2s ease,
    padding 0.2s ease,
    border-color 0.2s ease;
}
/* 折叠态：高度归零、去除 padding 与分隔线，body 仍留在 DOM 中
   （仅视觉裁剪），其内容宽度继续参与卡片 fit-content 计算，
   从而避免展开/收起时的宽度跳变。 */
.tool-card__body--collapsed {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-top-color: transparent;
  overflow: hidden;
}
.tool-card__section + .tool-card__section {
  margin-top: 8px;
}
.tool-card__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 2px;
}
.tool-card__section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
}
.tool-card__code {
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
.tool-card__body :deep(.n-code) {
  background: transparent;
  padding: 0;
}
.tool-card__empty {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}
</style>
