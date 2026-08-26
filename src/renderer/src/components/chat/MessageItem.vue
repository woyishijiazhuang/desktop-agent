<script setup lang="ts">
import { computed, provide, ref } from 'vue'
import { NTag, NButton, NIcon, useMessage } from 'naive-ui'
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
  CopyOutline,
  ChevronDownOutline,
  ChevronUpOutline,
  RefreshOutline,
  GitBranchOutline,
  WarningOutline
} from '@vicons/ionicons5'
import MarkdownRender from 'markstream-vue'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  TextContent,
  ThinkingContent,
  ToolCall as ToolCallBlock,
  ToolResultMessage,
  ImageContent
} from '@earendil-works/pi-ai'
import ReasoningBlock from './ReasoningBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
import UserImageBlock from './UserImageBlock.vue'
import UserFileBlock from './UserFileBlock.vue'
import UserSkillBlock from './UserSkillBlock.vue'
import { useChatStore } from '@renderer/store/useChatStore'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { useCopy } from '@renderer/composables/useCopy'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'
import { tryPrettyJSON, toCodeFence } from '@renderer/utils/codeBlock'
import { summarizeToolResult } from '@renderer/utils/toolResult'
import { mainClient } from '@renderer/utils/main-client'
import { chatMessageContextKey } from './chatMessageContext'
import {
  extractMessageText,
  extractUserText,
  isFileBlock,
  isSkillBlock,
  type FileTextBlock,
  type SkillTextBlock
} from '@renderer/utils/messageText'

const props = withDefaults(
  defineProps<{
    message: AgentMessage
    isLastMessage?: boolean
    /** 工具调用 → 匹配到的 toolResult（MessageList 合并时传入），供 ToolCallCard 展示结果 */
    matchedToolResults?: Map<string, ToolResultMessage>
  }>(),
  {
    isLastMessage: false
  }
)
const emit = defineEmits<{ regenerate: [] }>()
const chatStore = useChatStore()
const themeStore = useThemeStore()
const { copy } = useCopy()
const pauseStick = useStickToBottomPause()
const toast = useMessage()

const isUser = computed(() => props.message.role === 'user')
const isToolResult = computed(() => props.message.role === 'toolResult')

/** assistant 消息的 content block 列表 */
const blocks = computed(() => {
  const content = (props.message as { content: unknown }).content
  if (typeof content === 'string') {
    return [{ kind: 'text' as const, text: content }]
  }
  if (!Array.isArray(content)) return []
  return (content as (TextContent | ThinkingContent | ToolCallBlock)[]).map((b) => {
    if (b.type === 'text') return { kind: 'text' as const, text: b.text }
    if (b.type === 'thinking') return { kind: 'thinking' as const, thinking: b.thinking }
    if (b.type === 'toolCall') return { kind: 'toolCall' as const, toolCall: b }
    return { kind: 'text' as const, text: '' }
  })
})

/**
 * 该消息是否正在流式产出思考内容：仅末条消息 + isBusy + 末 block 为 thinking 时为 true。
 * 据此给末条 thinking block 传 live=true（自动展开 + 滚底），其余 thinking 视为终态（收起）。
 */
const thinkingLive = computed(() => {
  if (!props.isLastMessage || !chatStore.isBusy) return false
  if (isUser.value || isToolResult.value) return false
  const bs = blocks.value
  const last = bs[bs.length - 1]
  return !!last && last.kind === 'thinking'
})

/**
 * 该消息是否正在流式产出文本：仅末条消息 + isBusy + 末 block 为 text 时为 true。
 * 据此给末条 text block 传 final=false（流式），其余 final=true（终态稳定渲染）。
 */
const isStreaming = computed(() => {
  if (!props.isLastMessage || !chatStore.isBusy) return false
  if (isUser.value || isToolResult.value) return false
  const bs = blocks.value
  const last = bs[bs.length - 1]
  return !!last && last.kind === 'text'
})

/** user 消息纯文本（排除文件内容块，只含用户输入）。 */
const userText = computed(() => extractUserText((props.message as { content: unknown }).content))

/** user 消息中的文件内容块（file_name 标记，渲染为可展开的文件卡片）。 */
const userFiles = computed<FileTextBlock[]>(() => {
  const content = (props.message as { content: unknown }).content
  if (!Array.isArray(content)) return []
  return content.filter(isFileBlock)
})

/** user 消息中的技能内容块（skill_name 标记，渲染为技能卡片）。 */
const userSkills = computed<SkillTextBlock[]>(() => {
  const content = (props.message as { content: unknown }).content
  if (!Array.isArray(content)) return []
  return content.filter(isSkillBlock)
})

/** user 消息中的图片 block（多模态输入，base64 data）。 */
const userImages = computed(() => {
  const content = (props.message as { content: unknown }).content
  if (!Array.isArray(content)) return []
  return (content as ImageContent[]).filter((b) => b.type === 'image')
})

/** assistant 消息纯文本（用于复制：拼接所有 text block）。 */
const assistantText = computed(() =>
  extractMessageText((props.message as { content: unknown }).content)
)

/**
 * 失败标记行：assistant + 空内容 + finishReason='error'。
 * main 侧在「本轮真实失败且未落库任何 assistant 内容」时补一条占位行，
 * 使重启/重读库后 lastTurnFailed 仍能恢复「重试/编辑」入口；此处渲染为错误提示而非空气泡。
 */
const isFailedMarker = computed(() => {
  if (isUser.value || isToolResult.value) return false
  if (blocks.value.length > 0) return false
  const m = props.message as { stopReason?: string; finishReason?: string }
  return m.stopReason === 'error' || m.finishReason === 'error'
})

/** 失败标记行的错误文案（metadata.errorMessage > errorMessage > 兜底）。 */
const failedMessage = computed(() => {
  const m = props.message as {
    errorMessage?: string
    metadata?: { errorMessage?: string }
  }
  return m.metadata?.errorMessage || m.errorMessage || '生成失败'
})

/**
 * 思考被截断提示：assistant 消息仅有思考、无正文，且因 max_tokens 上限被截断
 *（stopReason/finishReason='length'，如推理模型长思考吃光输出预算）。
 * 这类结束不是报错，run 正常收尾，若不提示用户只看到"思考没完就停了"。
 * 渲染为警告提示条，引导提高该模型「最大输出 Tokens」或降低思考级别后重新生成。
 */
const isTruncatedThinking = computed(() => {
  if (isUser.value || isToolResult.value) return false
  const hasText = blocks.value.some((b) => b.kind === 'text' && b.text.trim())
  const hasThinking = blocks.value.some((b) => b.kind === 'thinking')
  if (hasText || !hasThinking) return false
  const m = props.message as { stopReason?: string; finishReason?: string }
  return m.stopReason === 'length' || m.finishReason === 'length'
})

/** toolResult 消息原始文本 */
const resultText = computed(() =>
  isToolResult.value ? extractMessageText((props.message as { content: unknown }).content) : ''
)

const toolResultName = computed(() => {
  if (!isToolResult.value) return ''
  return (props.message as { toolName?: string }).toolName ?? ''
})

const toolResultIsError = computed(() => {
  if (!isToolResult.value) return false
  return (props.message as { isError?: boolean }).isError ?? false
})

/** 孤儿 toolResult 的结果摘要（兜底卡收起时也可见一行「干了什么」）。 */
const toolResultSummary = computed(() => {
  if (!isToolResult.value) return null
  return summarizeToolResult(props.message as ToolResultMessage)
})

/**
 * 工具结果展示：尝试 JSON pretty-print + 语法高亮，否则纯文本。
 * - JSON：缩进 2 + ```json 围栏交给 markstream 以 Monaco 渲染
 * - 其它：等宽纯文本（不高亮，pre 轻量渲染）
 */
const displayInfo = computed(() => {
  const pretty = tryPrettyJSON(resultText.value)
  if (pretty !== null) return { text: pretty, language: 'json' as string | null }
  return { text: resultText.value, language: null as string | null }
})

/** 结果代码块内容：JSON → Monaco 高亮；纯文本 → pre 轻量渲染（等价原 NCode 无高亮）。 */
const resultFence = computed(() => toCodeFence(displayInfo.value.text, displayInfo.value.language))
const resultRenderer = computed<'monaco' | 'pre'>(() =>
  displayInfo.value.language ? 'monaco' : 'pre'
)

const isEmpty = computed(() => resultText.value.trim().length === 0)

/** 工具结果默认折叠（与工具调用卡片一致），点击头部展开/收起。 */
const expanded = ref(false)
/** 代码是否已渲染过：首次展开前不渲染代码块（懒渲染），
  大段结果（JSON 解析 + 代码块挂载）只在用户展开时付出成本；
  渲染后保留在 DOM，折叠动画与宽度稳定不受影响。 */
const codeRendered = ref(false)

function toggleExpand(): void {
  // 切换前解除粘底锁定，避免展开高度变化被当作流式增长强制滚底而闪烁
  pauseStick?.()
  expanded.value = !expanded.value
  if (expanded.value) codeRendered.value = true
}

/**
 * 内容区点击捕获（capture 阶段先于链接默认导航）：
 * 1. `a[href^="file://"]`（agent 回复的 `[文字](file:///...)` markdown 链接）：
 *    浏览器禁止 http/file 源页面直接导航到 file:// 资源（点击无反应），
 *    拦截后解码路径交主进程用系统默认程序打开。
 * 2. 可展开块点击（summary / 代码块折叠按钮）：解除粘底锁定，避免展开高度
 *    变化被当作流式增长强制滚底而闪烁。仅命中这两类才暂停，不影响链接、
 *    复制等不改变高度的点击。
 */
function onContentToggle(e: MouseEvent): void {
  const target = e.target
  if (!(target instanceof Element)) return
  const localLink = target.closest<HTMLAnchorElement>('a[href^="file://"]')
  if (localLink) {
    e.preventDefault()
    void openLocalPath(localLink.href)
    return
  }
  if (target.closest('summary, [aria-pressed]')) pauseStick?.()
}

/** 把 file:// 链接交主进程用系统默认程序打开；失败时提示原因。 */
async function openLocalPath(href: string): Promise<void> {
  try {
    await mainClient.app.openLocalPath(href)
  } catch (err) {
    toast.error(`无法打开本地文件：${err instanceof Error ? err.message : String(err)}`)
  }
}

function onCopy(): void {
  void copy(resultText.value, '结果')
}

/** 行级复制：user 取 userText，assistant 取 assistantText。 */
function onCopyMessage(): void {
  void copy(isUser.value ? userText.value : assistantText.value, '消息')
}

function onRegenerate(): void {
  emit('regenerate')
}

/** 从当前 user 消息开启新分支：复制此前历史到新会话，文本回填输入框供改写重发。 */
function onFork(): void {
  if (messageId.value === undefined) return
  void chatStore.forkFromMessage(messageId.value)
}

/** 消息时间戳（HH:mm），悬停时显露。Message 各变体均含 timestamp。 */
const timeText = computed(() => {
  const ts = (props.message as { timestamp?: number }).timestamp
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

/** DB 消息 id（搜索跳转滚动定位用；流式事件消息无 id 时为 undefined）。 */
const messageId = computed<number | undefined>(() => (props.message as { id?: number }).id)

/**
 * 向子树（markstream 自定义组件，如 EChartsBlock）提供本条消息的 DB id：
 * 图表「重新生成」需要把新配置就地替换回原消息，必须知道要改哪条消息。
 */
provide(chatMessageContextKey, messageId)
</script>

<template>
  <!-- toolResult 消息：结果卡片（高亮 / 折叠 / 复制），结构与工具调用卡片一致 -->
  <div v-if="isToolResult" class="row row--toolresult" :data-mid="messageId">
    <div class="row__body">
      <div class="tool-result" :class="{ 'tool-result--error': toolResultIsError }">
        <div
          class="tool-result__head"
          :class="{ 'tool-result__head--clickable': !isEmpty }"
          @click="toggleExpand"
        >
          <div class="tool-result__head-main">
            <span class="tool-result__title">
              <NIcon :color="toolResultIsError ? 'var(--error)' : 'var(--success)'" :size="15">
                <CloseCircleOutline v-if="toolResultIsError" />
                <CheckmarkCircleOutline v-else />
              </NIcon>
              <span class="tool-result__name">{{ toolResultName }}</span>
              <NTag :type="toolResultIsError ? 'error' : 'success'" size="tiny" round>
                {{ toolResultIsError ? '失败' : '成功' }}
              </NTag>
            </span>
            <span
              v-if="toolResultSummary"
              class="tool-result__summary"
              :class="`tool-result__summary--${toolResultSummary.tone}`"
            >
              {{ toolResultSummary.text }}
            </span>
          </div>
          <span class="tool-result__extra">
            <NButton
              v-if="!isEmpty"
              quaternary
              size="tiny"
              :focusable="false"
              title="复制结果"
              @click.stop="onCopy"
            >
              <template #icon>
                <NIcon><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NIcon v-if="!isEmpty" class="tool-result__chevron" :size="14" title="展开/收起">
              <ChevronUpOutline v-if="expanded" />
              <ChevronDownOutline v-else />
            </NIcon>
          </span>
        </div>

        <div
          v-if="!isEmpty"
          class="tool-result__body"
          :class="{ 'tool-result__body--collapsed': !expanded }"
        >
          <MarkdownRender
            v-if="codeRendered"
            mode="chat"
            custom-id="tool-result"
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
            class="tool-result__markdown"
          />
        </div>
        <div v-else class="tool-result__empty">（无输出）</div>
      </div>
    </div>
  </div>

  <!-- user / assistant 消息：左右分离（用户右侧气泡 / 助手左侧全宽） -->
  <div v-else class="row" :class="isUser ? 'row--user' : 'row--assistant'" :data-mid="messageId">
    <div class="row__body">
      <div
        class="row__content"
        :class="{ 'row__content--user': isUser }"
        @click.capture="onContentToggle"
      >
        <template v-if="isUser">
          <UserImageBlock v-for="(img, i) in userImages" :key="i" :block="img" />
          <template v-if="userText">{{ userText }}</template>
          <UserSkillBlock
            v-for="(s, i) in userSkills"
            :key="i"
            :name="s.skill_name"
            :text="s.text"
          />
          <UserFileBlock v-for="(f, i) in userFiles" :key="i" :name="f.file_name" :text="f.text" />
        </template>
        <template v-else>
          <div v-if="isFailedMarker" class="row__failed-marker">
            <NIcon :size="16" :color="'var(--error)'"><CloseCircleOutline /></NIcon>
            <span class="row__failed-marker__text">{{ failedMessage }}</span>
          </div>
          <div v-if="isTruncatedThinking" class="row__truncated-tip">
            <NIcon :size="16" :color="'var(--warning)'"><WarningOutline /></NIcon>
            <span class="row__truncated-tip__text"
              >思考内容已达到该模型的最大输出长度（max_tokens）而被截断，未生成回答。可在「设置
              →模型」中提高该模型的「最大输出 Tokens」，或降低思考级别后重新生成。</span
            >
          </div>
          <template v-for="(block, i) in blocks" :key="i">
            <ReasoningBlock
              v-if="block.kind === 'thinking'"
              :thinking="block.thinking"
              :live="thinkingLive && i === blocks.length - 1"
            />
            <ToolCallCard
              v-else-if="block.kind === 'toolCall'"
              :tool-call="block.toolCall"
              :status="chatStore.toolStatus[block.toolCall.id]"
              :result="matchedToolResults?.get(block.toolCall.id)"
            />
            <!-- 代码块视口提前渲染：viewport-priority 的延迟观察器在窗口可见时正常工作，
                 viewport-priority-options 的提前量（rootMargin/heavyBlockMargin）让重节点
                 在「快进入视口」时提前挂载 Monaco 编辑器，避免滚入视口瞬间
                 「灰白占位 → 彩色编辑器」的闪烁。
                 node-virtual=false：markstream 对 chat 模式 final 消息（>50 节点）自动启用
                 节点虚拟化——视口外节点卸载并换成「估算高度」占位，滚动时窗口移动造成的
                 估算误差会让内容整体位移（滚动跳变的根源）。聊天消息量级全量渲染无压力，
                 显式关闭以保证滚动稳定；Monaco 等重节点仍由 viewport-priority 延迟挂载。 -->
            <MarkdownRender
              v-else-if="block.kind === 'text' && block.text"
              mode="chat"
              custom-id="chat"
              :content="block.text"
              :final="!(isStreaming && i === blocks.length - 1)"
              code-renderer="monaco"
              :is-dark="themeStore.isDark"
              :node-virtual="false"
              viewport-priority
              :viewport-priority-options="{
                rootMargin: '900px',
                heavyBlockMargin: '900px'
              }"
              :code-block-props="{
                showCopyButton: true,
                showHeader: true,
                theme: { light: 'vitesse-light', dark: 'vitesse-dark' }
              }"
              class="row__markdown"
            />
          </template>
        </template>
      </div>

      <!-- 悬停操作条：时间戳 + 复制（始终）+ 重新生成（仅末条 assistant 且空闲） -->
      <div class="row__actions">
        <span v-if="timeText" class="row__time">{{ timeText }}</span>
        <NButton quaternary size="tiny" :focusable="false" title="复制" @click="onCopyMessage">
          <template #icon
            ><NIcon><CopyOutline /></NIcon
          ></template>
        </NButton>
        <NButton
          v-if="isUser && messageId !== undefined"
          quaternary
          size="tiny"
          :focusable="false"
          title="从此消息开启新分支（复制此前历史，可改写后重新提问）"
          @click="onFork"
        >
          <template #icon
            ><NIcon><GitBranchOutline /></NIcon
          ></template>
        </NButton>
        <NButton
          v-if="!isUser && isLastMessage && !chatStore.isBusy"
          quaternary
          size="tiny"
          :focusable="false"
          title="重新生成"
          @click="onRegenerate"
        >
          <template #icon
            ><NIcon><RefreshOutline /></NIcon
          ></template>
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 消息行（左右分离：用户右侧气泡 / 助手左侧全宽） ===== */
/* 消息正文允许自由选择复制（全局 body 禁选，仅在消息区放开，对齐 ChatGPT/Claude 等主流产品） */
.row__content,
.tool-result__body {
  user-select: text;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  position: relative;
  /* 为悬停操作条预留空间，同时统一消息间距；操作条绝对定位于此区域内，
     仍在 .row 的 hover 盒子内，避免鼠标移到操作条时丢失 hover。 */
  padding-bottom: 26px;
  max-width: 100%;
}
/* 用户行：内容翻到右侧 */
.row--user {
  flex-direction: row-reverse;
  align-items: center;
}
.row__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative;
}
/* 用户内容右对齐 */
.row--user .row__body {
  align-items: flex-end;
}
.row__content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-1);
  word-break: break-word;
  min-width: 0;
  max-width: var(--msg-max-width);
}
/* 消息内多个内容块（思考块 / 工具调用卡 / 文本）相邻时保持间距，避免卡片互相贴合 */
.row__content > * + * {
  margin-top: 8px;
}
/* user 消息：淡底圆角气泡，宽度贴合文本 */
.row__content--user {
  background: var(--user-msg-bg);
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  white-space: pre-wrap;
}
/* assistant 消息走 Markdown 渲染：由 markstream 控制空白与块级布局，不强制 pre-wrap */
.row__markdown {
  min-width: 0;
}

/* 失败标记行（重启后恢复重试入口的占位）：错误色弱底 + 图标 + 文案 */
.row__failed-marker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--error-soft);
  border-radius: var(--radius);
  background: var(--error-soft);
  color: var(--error);
  font-size: 13px;
  max-width: var(--msg-max-width);
}
.row__failed-marker__text {
  word-break: break-word;
}

/* 思考被截断提示条（思考吃光 max_tokens 上限、无正文）：警告色弱底 + 图标 + 文案 */
.row__truncated-tip {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--warning-soft);
  border-radius: var(--radius);
  background: var(--warning-soft);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.5;
  max-width: var(--msg-max-width);
}
.row__truncated-tip__text {
  word-break: break-word;
}

/*
 * 内联悬停操作条：绝对定位贴在内容正下方（落入 .row 的 padding-bottom 区域），
 * 不参与流内高度计算，从而不影响头像与气泡的居中对齐；hover 显现。
 * 用户行右对齐，助手行左对齐。
 */
.row__actions {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.row--user .row__actions {
  left: auto;
  right: 0;
}
.row:hover .row__actions {
  opacity: 1;
  pointer-events: auto;
}
.row__time {
  font-size: 11px;
  color: var(--text-3);
  margin-right: 4px;
  white-space: nowrap;
}

/* ===== toolResult 卡片（结构与工具调用卡片一致） ===== */
.tool-result {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  overflow: hidden;
  max-width: var(--msg-max-width);
  width: fit-content;
  min-width: 200px;
}
.tool-result--error {
  border-color: var(--error-soft);
}
.tool-result__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
}
.tool-result__head-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tool-result__head--clickable {
  cursor: pointer;
}
.tool-result__head--clickable:hover {
  background: var(--hover-bg);
}
.tool-result__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 结果摘要：收起时也可见的一行「工具干了什么」文案 */
.tool-result__summary {
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-result__summary--success {
  color: var(--success);
}
.tool-result__summary--error {
  color: var(--error);
}
.tool-result__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-result__extra {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.tool-result__chevron {
  color: var(--text-3);
}
.tool-result__body {
  border-top: 1px solid var(--border-soft);
  background: var(--code-bg);
  max-height: 400px;
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
.tool-result__body--collapsed {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  border-top-color: transparent;
  overflow: hidden;
}
/* 结果代码块（markstream 渲染）：字号与卡片一致，宽度不超出卡片。
   纯文本（pre 渲染）结果保持自动换行，等价原 NCode 的 word-wrap。 */
.tool-result__markdown {
  font-size: 12px;
  max-width: 100%;
}
.tool-result__markdown :deep(pre) {
  white-space: pre-wrap;
  word-break: break-word;
}
.tool-result__empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}
</style>
