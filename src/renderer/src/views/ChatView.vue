<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage, NButton, NAlert, NIcon } from 'naive-ui'
import { RefreshOutline, PencilOutline, Sparkles, SettingsOutline } from '@vicons/ionicons5'
import MessageList from '@renderer/components/chat/MessageList.vue'
import ChatInput from '@renderer/components/chat/ChatInput.vue'
import SessionSidebar from '@renderer/components/sidebar/SessionSidebar.vue'
import PermissionBar from '@renderer/components/permission/PermissionBar.vue'
import PlanApprovalBar from '@renderer/components/permission/PlanApprovalBar.vue'
import AskUserBar from '@renderer/components/permission/AskUserBar.vue'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useChatStore, type ComposerAttachment } from '@renderer/store/useChatStore'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'

const sessionStore = useSessionStore()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()
const modelConfigs = useModelConfigsStore()
const router = useRouter()
const message = useMessage()

/** 首屏数据是否就绪（避免无模型引导在加载完成前闪烁）。 */
const initialized = ref(false)

/** 是否可回收：末条消息是 user 时才允许「编辑」回填（工具调用中途失败时不可回收）。 */
const canRecall = computed(() => {
  const list = chatStore.messages
  return list.length > 0 && list[list.length - 1].role === 'user'
})

// 错误统一用全局 message 提示（替代原内联 error banner）
watch(
  () => chatStore.error,
  (err) => {
    if (err) {
      message.error(friendlyError(err))
      chatStore.clearError()
    }
  }
)

/** 将底层错误信息映射为用户友好的提示。 */
function friendlyError(msg: string): string {
  const lower = msg.toLowerCase()
  if (
    lower.includes('401') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return 'API Key 无效或已过期，请在「设置」中编辑模型重新配置。'
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('quota')) {
    return '请求过于频繁或额度不足，请稍后再试。'
  }
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('econn')) {
    return '网络连接失败，请检查网络后重试。'
  }
  if (lower.includes('aborted')) {
    return '已中止生成。'
  }
  return msg
}

onMounted(async () => {
  // 启动时加载模型配置 + 设置 + 会话列表，并行执行以加快首屏。
  await Promise.all([
    modelConfigs.load(),
    modelConfigs.loadLastUsed(),
    settingsStore.loadSettings(),
    sessionStore.load()
  ])
  // 首次启动初始化当前会话：有会话则回到最近一条，无会话则进入临时空对话（不写库）。
  // remount（/settings↔/chat 往返）时 hasInitialized 已 true，跳过以保留用户当前状态
  //（包括用户主动进入的临时空对话）。
  if (!sessionStore.hasInitialized) {
    sessionStore.hasInitialized = true
    const recent = sessionStore.sessions[0]
    if (recent) {
      await sessionStore.select(recent.id)
    } else {
      await sessionStore.startNewChat()
    }
  }
  initialized.value = true

  // 全局快捷键：Cmd/Ctrl+N 新建会话
  window.addEventListener('keydown', onGlobalKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

function onGlobalKeydown(e: KeyboardEvent): void {
  // Cmd/Ctrl+N：新建会话（避开浏览器默认行为）
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    void sessionStore.startNewChat()
  }
}

function onSend(text: string, attachments?: ComposerAttachment[], skills?: string[]): void {
  void chatStore.send(text, attachments, skills)
}

function onAbort(): void {
  chatStore.abort()
}

/** 重试上一轮失败的对话（main 侧清理 + 重跑，事件流自动回传）。 */
function onRetry(): void {
  void chatStore.retry()
}

/** 重新生成最后一条 assistant 回复（main 侧删除末条 assistant + 重跑）。 */
function onRegenerate(): void {
  void chatStore.regenerate()
}

/** 回收失败的用户消息到输入框，供编辑后重发。 */
function onRecall(): void {
  void chatStore.recallLastMessage()
}

/** 引导：跳转到设置页添加模型。 */
function goToSettings(): void {
  void router.push('/settings')
}
</script>

<template>
  <div class="chat-view">
    <!-- 左侧会话侧栏 -->
    <SessionSidebar />

    <!-- 右侧聊天主区 -->
    <div class="chat-view__main">
      <!-- 未添加任何模型时的引导：不展示聊天区，仅引导去设置添加 -->
      <div v-if="initialized && !modelConfigs.hasModel" class="chat-view__setup">
        <div class="chat-view__setup-icon">
          <NIcon :size="30"><Sparkles /></NIcon>
        </div>
        <p class="chat-view__setup-title">需要添加模型</p>
        <p class="chat-view__setup-desc">
          支持预置服务商（DeepSeek / Anthropic / OpenAI / Groq 等）或完全自定义（本地地址 / OpenAI
          兼容端点）。在「设置」中添加一个模型即可开始对话，每个模型独立配置 API
          Key，加密保存于本机。
        </p>

        <button class="chat-view__setup-btn" @click="goToSettings">
          <NIcon :size="16"><SettingsOutline /></NIcon>
          前往设置添加模型
        </button>
      </div>

      <template v-else-if="initialized">
        <MessageList
          :messages="chatStore.messages"
          :is-busy="chatStore.isBusy"
          :session-id="chatStore.currentSessionId"
          :compress-last-index="chatStore.compressLastIndex"
          :compress-summary="chatStore.compressSummary"
          @send="onSend"
          @regenerate="onRegenerate"
        />
        <!-- 失败操作条：上一轮真实失败且当前空闲时显示，可重试或回填编辑 -->
        <NAlert
          v-if="!chatStore.isBusy && chatStore.lastTurnFailed"
          class="chat-view__failure"
          type="error"
          :bordered="false"
        >
          <div class="chat-view__failure-inner">
            <span>发送失败，可重试或编辑后重发</span>
            <div class="chat-view__failure-actions">
              <NButton size="small" type="primary" @click="onRetry">
                <template #icon>
                  <NIcon><RefreshOutline /></NIcon>
                </template>
                重试
              </NButton>
              <NButton v-if="canRecall" size="small" tertiary @click="onRecall">
                <template #icon>
                  <NIcon><PencilOutline /></NIcon>
                </template>
                编辑
              </NButton>
            </div>
          </div>
        </NAlert>
        <!-- 批量操作条：多个工具同时等待确认时提供全部允许/拒绝 -->
        <PermissionBar />
        <!-- 计划审批卡片：Agent 提交计划后展示，供用户批准/拒绝 -->
        <PlanApprovalBar />
        <!-- 澄清问题卡片：Agent 调用 ask_user 后展示，供用户作答/跳过 -->
        <AskUserBar />
        <div class="chat-view__composer">
          <ChatInput :is-busy="chatStore.isBusy" @send="onSend" @abort="onAbort" />
        </div>
      </template>

      <!-- 首屏加载占位 -->
      <div v-else class="chat-view__loading">加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex: 1;
  height: 100%;
  min-width: 0;
}
.chat-view__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* 960 → 992：消息区内容加了左右 16px 对称内边距（为滚动条轨道让位），
   * 加宽抵消内边距，消息有效宽度基本不变 */
  max-width: 992px;
  margin: 0 auto;
  padding: 0 24px 16px;
  width: 100%;
}
.chat-view__setup {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
  color: var(--text-2);
  padding: 24px;
}
.chat-view__setup-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-soft);
  color: var(--primary-pressed);
  margin-bottom: 6px;
}
.chat-view__setup-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-1);
}
.chat-view__setup-desc {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
  max-width: 400px;
}
.chat-view__setup-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border: none;
  border-radius: var(--radius);
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.1s ease;
}
.chat-view__setup-btn:hover {
  background: var(--primary-hover);
}
.chat-view__loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-3);
}
.chat-view__failure {
  margin: 8px 0 0;
}
.chat-view__failure-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
.chat-view__failure-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.chat-view__composer {
  padding-top: 12px;
}
</style>
