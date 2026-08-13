<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { NIcon, useMessage } from 'naive-ui'
import { Sparkles, RefreshOutline } from '@vicons/ionicons5'
import { mainClient } from '@renderer/utils/main-client'

const props = defineProps<{
  /** 空会话且正在生成（无消息时的"思考中"状态）。 */
  isBusy: boolean
  /** 当前会话 id（AI 建议生成 / 用量记录用；临时会话可能为 null）。 */
  sessionId?: string | null
}>()

const emit = defineEmits<{ send: [text: string] }>()
const message = useMessage()

/** 静态兜底建议（AI 生成失败/未请求时展示）。 */
const FALLBACK_SUGGESTIONS = [
  '用 Python 写一个快速排序，并解释原理',
  '解释一下 JavaScript 闭包是什么',
  '帮我润色一段工作汇报，让它更简洁专业',
  '给我一些提升专注力的可行建议'
]

/** 当前展示的建议（初始为静态，点「换一批」后替换为 AI 生成结果）。 */
const suggestions = ref<string[]>(FALLBACK_SUGGESTIONS)
/** 正在生成 AI 建议。 */
const generating = ref(false)
/** 是否已生成过 AI 建议（用于展示「由 AI 生成」提示）。 */
const aiGenerated = ref(false)

/** 换一批：按当前会话/默认模型生成 4 条建议；失败保留现有建议并提示。 */
async function refreshSuggestions(): Promise<void> {
  if (generating.value) return
  generating.value = true
  try {
    const list = await mainClient.agent.generateWelcomeSuggestions(props.sessionId ?? null)
    if (list.length > 0) {
      suggestions.value = list
      aiGenerated.value = true
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : '生成建议失败，请稍后重试')
  } finally {
    generating.value = false
  }
}

/** 挂载时复用上次持久化的建议（跨会话/重启），无则保持静态兜底。 */
onMounted(async () => {
  const saved = await mainClient.agent.getWelcomeSuggestions()
  if (saved.length > 0) {
    suggestions.value = saved
    aiGenerated.value = true
  }
})
</script>

<template>
  <div class="welcome">
    <div v-if="isBusy" class="welcome__thinking">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="welcome__thinking-text">思考中…</span>
    </div>
    <template v-else>
      <div class="welcome__icon">
        <NIcon :size="28"><Sparkles /></NIcon>
      </div>
      <h2 class="welcome__title">有什么可以帮你的？</h2>
      <p class="welcome__desc">选择一个话题开始，或直接在下方输入你的问题。</p>
      <div class="welcome__chips">
        <button
          v-for="s in suggestions"
          :key="s"
          type="button"
          class="welcome__chip"
          @click="emit('send', s)"
        >
          {{ s }}
        </button>
      </div>
      <button
        type="button"
        class="welcome__refresh"
        :disabled="generating"
        :title="aiGenerated ? '重新生成一批建议' : '生成一批 AI 建议'"
        @click="refreshSuggestions"
      >
        <NIcon :size="13" :class="{ 'welcome__refresh-icon--spin': generating }">
          <RefreshOutline />
        </NIcon>
        {{ generating ? '生成中…' : aiGenerated ? '换一批' : '换一批建议' }}
        <span v-if="aiGenerated && !generating" class="welcome__refresh-tag">由 AI 生成</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
/* 欢迎页占满消息区（flex 容器直接居中，不再依赖滚动容器的 min-height 撑满） */
.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 24px;
  gap: 10px;
}
.welcome__icon {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-soft);
  color: var(--primary-pressed);
  margin-bottom: 6px;
}
.welcome__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-1);
}
.welcome__desc {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-3);
}
.welcome__chips {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 420px;
}
.welcome__chip {
  padding: 11px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s ease,
    border-color 0.12s ease,
    color 0.12s ease;
}
.welcome__chip:hover {
  background: var(--hover-bg);
  border-color: var(--primary);
  color: var(--text-1);
}

/* 换一批按钮：次级、柔和，生成中图标旋转 */
.welcome__refresh {
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.welcome__refresh:hover:not(:disabled) {
  background: var(--hover-bg);
  color: var(--text-1);
}
.welcome__refresh:disabled {
  cursor: default;
  opacity: 0.7;
}
.welcome__refresh-icon--spin {
  animation: refresh-spin 0.8s linear infinite;
}
.welcome__refresh-tag {
  font-size: 11px;
  color: var(--primary-pressed);
}
@keyframes refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 思考中动效 */
.welcome__thinking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-3);
  font-size: 13px;
}
.welcome__thinking-text {
  margin-left: 2px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  animation: dot-bounce 1.2s infinite ease-in-out;
}
.dot:nth-child(2) {
  animation-delay: 0.15s;
}
.dot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes dot-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}
</style>
