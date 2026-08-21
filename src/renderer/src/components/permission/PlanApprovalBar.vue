<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NIcon, NInput, NTag } from 'naive-ui'
import { DocumentTextOutline } from '@vicons/ionicons5'
import { usePlanStore } from '@renderer/store/usePlanStore'
import { useChatStore } from '@renderer/store/useChatStore'

/**
 * 计划审批卡片：Agent 调用 exit_plan_mode 提交计划后展示在输入框上方。
 * 展示计划标题与完整文本，提供「批准 / 拒绝」入口（拒绝可附反馈，回传给 Agent 调整）。
 */
const planStore = usePlanStore()
const chatStore = useChatStore()

const current = computed(() => planStore.forSession(chatStore.currentSessionId))
/** 拒绝时的可选反馈。 */
const feedback = ref('')

function onApprove(): void {
  if (!chatStore.currentSessionId) return
  planStore.respond(chatStore.currentSessionId, true, '')
  feedback.value = ''
}

function onReject(): void {
  if (!chatStore.currentSessionId) return
  planStore.respond(chatStore.currentSessionId, false, feedback.value.trim())
  feedback.value = ''
}
</script>

<template>
  <Transition name="plan-bar">
    <div v-if="current" class="plan-bar">
      <div class="plan-bar__head">
        <span class="plan-bar__title">
          <NIcon :size="14" class="plan-bar__icon"><DocumentTextOutline /></NIcon>
          AI 提交了计划：{{ current.title }}
        </span>
        <NTag size="tiny" type="warning" :bordered="false">待审批</NTag>
      </div>

      <pre class="plan-bar__body">{{ current.plan }}</pre>

      <div v-if="current" class="plan-bar__feedback">
        <NInput
          v-model:value="feedback"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          placeholder="拒绝时可填写反馈，AI 将据此调整计划（批准无需填写）"
          size="small"
        />
      </div>

      <div class="plan-bar__actions">
        <NButton size="small" type="success" title="批准计划，AI 开始执行" @click="onApprove">
          批准
        </NButton>
        <NButton size="small" title="拒绝计划，AI 根据反馈调整后重新提交" @click="onReject">
          拒绝
        </NButton>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.plan-bar {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plan-bar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.plan-bar__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
}
.plan-bar__icon {
  color: var(--warning);
  flex-shrink: 0;
}
.plan-bar__body {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--code-bg);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.plan-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 出现/消失淡入淡出 */
.plan-bar-enter-active,
.plan-bar-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.plan-bar-enter-from,
.plan-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
