<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NTag, NButton, NIcon } from 'naive-ui'
import MarkdownRender from 'markstream-vue'
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
import { useThemeStore } from '@renderer/store/useThemeStore'
import { useCopy } from '@renderer/composables/useCopy'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'
import { tryPrettyJSON, toCodeFence } from '@renderer/utils/codeBlock'
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

/** 参数区代码块（恒为 JSON）：包成 ```json 围栏交给 markstream 以 Monaco 渲染。 */
const argsFence = computed(() => toCodeFence(argsText.value, 'json'))

/** 结果区代码块：JSON → Monaco 高亮；纯文本 → pre 轻量渲染（等价原 NCode 无高亮）。 */
const resultFence = computed(() =>
  toCodeFence(resultDisplay.value.text, resultDisplay.value.language)
)
const resultRenderer = computed<'monaco' | 'pre'>(() =>
  resultDisplay.value.language ? 'monaco' : 'pre'
)

const themeStore = useThemeStore()
/**
 * edit_file 的标准 unified diff（来自 details.diff，历史消息同样有）：
 * 用 markstream 的 diff 渲染器（Monaco DiffEditor，+/- 着色、hunk 信息）。
 * 包成 ```diff 围栏交给 MarkdownRender；无 diff（失败结果）时回退普通代码块。
 */
const editDiffContent = computed(() => {
  if (props.toolCall.name !== 'edit_file' || !props.result) return null
  const diff = (props.result.details as Record<string, unknown> | undefined)?.diff
  return typeof diff === 'string' && diff.includes('@@') ? `\`\`\`diff\n${diff}\n\`\`\`` : null
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
/** 代码是否已渲染过：首次展开前不渲染代码块（懒渲染），
  避免折叠时仍做 JSON 序列化 + 代码块挂载；渲染后保留在 DOM。 */
const codeRendered = ref(false)
/** 可滚动 body（流式输出时自动滚底）。 */
const bodyRef = ref<HTMLElement | null>(null)

/** 执行中的流式输出（tool_execution_update 快照）；仅 running 期间非空，结束后由终态结果接管。 */
const streamText = computed(() =>
  props.status?.status === 'running' ? (props.status.stream ?? '') : ''
)
const isStreaming = computed(() => !!streamText.value)

/** 流式输出到达：自动展开卡片并跟随滚动到底部，让用户实时看到命令输出。
 *  注意不要在此解除粘底（pauseStick）：用户贴底确认工具后若解除跟随，
 *  后续输出/新内容增长时视口会脱离底部、不再自动滚底（用户正在底部时本就应继续跟随；
 *  不在底部时 stick 已为 false，展开不会把视口拉回底部）。 */
watch(streamText, () => {
  if (!streamText.value) return
  if (!expanded.value) {
    expanded.value = true
    codeRendered.value = true
  }
  void nextTick(() => {
    if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  })
})

const canExpand = computed(() => hasArgs.value || hasResult.value || isStreaming.value)

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
        </span>
      </div>
      <span class="tool-card__extra">
        <span
          v-if="resultSummary"
          class="tool-card__summary"
          :class="`tool-card__summary--${resultSummary.tone}`"
        >
          {{ resultSummary.text }}
        </span>
        <NTag :type="statusType" size="tiny" round>{{ statusLabel }}</NTag>
        <NIcon v-if="canExpand" class="tool-card__chevron" :size="14" title="展开/收起详情">
          <ChevronUpOutline v-if="expanded" />
          <ChevronDownOutline v-else />
        </NIcon>
      </span>
    </div>

    <div
      v-if="canExpand"
      ref="bodyRef"
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
        <MarkdownRender
          v-if="codeRendered"
          mode="chat"
          custom-id="tool-card"
          :content="argsFence"
          final
          code-renderer="monaco"
          :is-dark="themeStore.isDark"
          :code-block-props="{
            showCopyButton: false,
            showHeader: false,
            theme: { light: 'vitesse-light', dark: 'vitesse-dark' },
            monacoOptions: { wordWrap: 'on' }
          }"
          class="tool-card__markdown"
        />
      </div>

      <!-- 执行中的流式输出：仅 running 期间展示，完成后由「结果」终态接管 -->
      <div v-if="isStreaming" class="tool-card__section">
        <div class="tool-card__section-head">
          <span class="tool-card__section-label">实时输出</span>
        </div>
        <pre class="tool-card__stream">{{ streamText }}</pre>
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
        <!-- edit_file：标准 unified diff 走 Monaco DiffEditor 渲染（+/- 着色、hunk 信息） -->
        <MarkdownRender
          v-if="codeRendered && editDiffContent"
          mode="chat"
          custom-id="tool-diff"
          :content="editDiffContent"
          final
          code-renderer="monaco"
          :is-dark="themeStore.isDark"
          :code-block-props="{
            showCopyButton: false,
            showHeader: false,
            monacoOptions: { MAX_HEIGHT: 300, diffWordWrap: 'on' },
            theme: { light: 'vitesse-light', dark: 'vitesse-dark' }
          }"
          class="tool-card__diff"
        />
        <MarkdownRender
          v-else-if="codeRendered"
          mode="chat"
          custom-id="tool-card"
          :content="resultFence"
          final
          :code-renderer="resultRenderer"
          :is-dark="themeStore.isDark"
          :code-block-props="{
            showCopyButton: false,
            showHeader: false,
            theme: { light: 'vitesse-light', dark: 'vitesse-dark' },
            monacoOptions: { wordWrap: 'on' }
          }"
          class="tool-card__markdown"
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
  /* width: fit-content; */
  /* min-width: 200px; */
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
  /* 占据头部剩余宽度（右侧 extra 限宽），为 reason 提供弹性空间 */
  flex: 1;
  min-width: 0;
}
.tool-card__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.tool-card__name {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  white-space: nowrap;
  /* 工具名不参与压缩：完整展示，由 reason 吸收宽度变化 */
  flex-shrink: 0;
}
/* AI 一句话说明（reason）：与工具名区分使用普通字体、弱化颜色；
   弹性占据工具名之后的剩余宽度，超出省略（min-width:0 允许收缩出省略号） */
.tool-card__reason {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
/* 结果摘要：收起时也可见的「工具干了什么」一行文案；
   上限 extra 限宽，超出省略 */
.tool-card__summary {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
/* 头部右侧（摘要 + 状态 + 展开箭头）：整体限宽（不超过头部 45%），
   溢出空间由内部摘要吸收省略；状态标签与箭头保持固有宽度不被压缩 */
.tool-card__extra {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  max-width: 45%;
  min-width: 0;
}
.tool-card__extra :deep(.n-tag) {
  flex-shrink: 0;
}
.tool-card__chevron {
  color: var(--text-3);
  flex-shrink: 0;
}
.tool-card__body {
  border-top: 1px solid var(--border-soft);
  background: var(--code-bg);
  max-height: 420px;
  overflow: auto;
  /* 始终为滚动条预留 gutter，避免滚动条出现/消失时文字宽度变化导致重排。 */
  scrollbar-gutter: stable;
  /* padding 统一收拢到此处，作为唯一边距来源；
     代码块内容由 markstream 自带间距，此处不额外叠加。 */
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
/* 参数/结果代码块（markstream 渲染）：字号与卡片一致，宽度不超出卡片。
   纯文本（pre 渲染）结果保持自动换行，等价原 NCode 的 word-wrap。 */
.tool-card__markdown {
  font-size: 12px;
  max-width: 100%;
}
.tool-card__markdown :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}
/* edit_file 的 diff 块：宽度不超出卡片，与普通代码块视觉对齐 */
.tool-card__diff {
  font-size: 12px;
  max-width: 100%;
}
/* 流式输出（执行中）：等宽字体 + 自动换行，正文跟随 body 滚动 */
.tool-card__stream {
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-width: 100%;
}
.tool-card__empty {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}
</style>
