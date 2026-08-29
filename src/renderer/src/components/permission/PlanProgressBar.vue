<script setup lang="ts">
import { computed } from 'vue'
import { NIcon, NPopover } from 'naive-ui'
import { Checkmark, DocumentTextOutline } from '@vicons/ionicons5'
import { usePlanStore } from '@renderer/store/usePlanStore'
import { useChatStore } from '@renderer/store/useChatStore'
import type { PlanStepProgress } from '@main/agent/types'

/**
 * 计划执行进度条：计划批准后展示在输入框上方（细状态条）。
 * 折叠态一行显示「进行到第几步」，点击弹出完整步骤列表（进行中高亮 / 完成打勾）。
 * 由 report_step 上报驱动（main 经 onPlanProgress 推送），agent_start 清除、agent_end 保留最终态。
 */
const planStore = usePlanStore()
const chatStore = useChatStore()

const progress = computed(() => planStore.progressForSession(chatStore.currentSessionId))

const steps = computed<PlanStepProgress[]>(() => progress.value?.steps ?? [])

const doneCount = computed(() => steps.value.filter((s) => s.status === 'done').length)

/** 当前进行中的步骤（可能无：尚未开始或已全部完成）。 */
const currentIndex = computed(() => steps.value.findIndex((s) => s.status === 'in_progress'))

const allDone = computed(() => steps.value.length > 0 && doneCount.value === steps.value.length)

/** 折叠态文案：完成 / 进行中（含当前步骤）/ 部分完成 / 等待开始。 */
const barText = computed(() => {
  const total = steps.value.length
  if (total === 0) return ''
  if (allDone.value) return `计划已完成 · ${total}/${total} 步`
  if (currentIndex.value >= 0) {
    return `计划进行中 · 步骤 ${currentIndex.value + 1}/${total} · ${steps.value[currentIndex.value].title}`
  }
  if (doneCount.value > 0) return `计划执行中 · 已完成 ${doneCount.value}/${total} 步`
  return '计划已批准 · 等待开始执行'
})

/** 步骤状态徽标标题（弹层内 tooltip）。 */
function statusText(s: PlanStepProgress): string {
  if (s.status === 'done') return '已完成'
  if (s.status === 'in_progress') return '进行中'
  return '待执行'
}

/**
 * 隐藏 NPopover 默认容器样式（透明背景/无阴影/无内边距），
 * 仅保留自定义步骤卡片，避免外层直角容器叠加在圆角卡片上。
 */
const popoverTheme = {
  color: 'transparent',
  boxShadow: 'none',
  padding: '0',
  borderRadius: '0'
}
</script>

<template>
  <NPopover
    v-if="progress"
    trigger="click"
    placement="top-start"
    :width="380"
    raw
    :theme-overrides="popoverTheme"
  >
    <template #trigger>
      <button class="plan-progress" :title="progress.title">
        <NIcon :size="13" class="plan-progress__icon"><DocumentTextOutline /></NIcon>
        <span class="plan-progress__text">{{ barText }}</span>
        <span class="plan-progress__hint">查看步骤</span>
      </button>
    </template>

    <div class="plan-progress__pop">
      <div class="plan-progress__pop-head">
        <span class="plan-progress__pop-title">计划：{{ progress.title }}</span>
        <span v-if="allDone" class="plan-progress__pop-done">已完成</span>
        <span v-else class="plan-progress__pop-running">{{ doneCount }}/{{ steps.length }} 步</span>
      </div>
      <div class="plan-progress__steps">
        <div
          v-for="(s, i) in steps"
          :key="i"
          class="plan-progress__step"
          :class="`plan-progress__step--${s.status}`"
          :title="statusText(s)"
        >
          <span class="plan-progress__dot" />
          <span class="plan-progress__step-idx">{{ i + 1 }}</span>
          <span class="plan-progress__step-title">{{ s.title }}</span>
          <NIcon v-if="s.status === 'done'" :size="13" class="plan-progress__step-done">
            <Checkmark />
          </NIcon>
        </div>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.plan-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  margin-top: 6px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-soft);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
  max-width: 100%;
}
.plan-progress:hover {
  border-color: var(--border);
  background: var(--hover-bg);
}
.plan-progress__icon {
  color: var(--warning);
  flex-shrink: 0;
}
.plan-progress__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.plan-progress__hint {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 11px;
}
/* 弹层：步骤列表 */
.plan-progress__pop {
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
}
.plan-progress__pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 12px;
}
.plan-progress__pop-title {
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-progress__pop-done {
  flex-shrink: 0;
  color: var(--success);
}
.plan-progress__pop-running {
  flex-shrink: 0;
  color: var(--text-3);
}
.plan-progress__steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow: auto;
}
.plan-progress__step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.plan-progress__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}
.plan-progress__step--in_progress {
  background: var(--hover-bg);
  color: var(--text-1);
}
.plan-progress__step--in_progress .plan-progress__dot {
  background: var(--primary);
  animation: plan-progress-pulse 1.2s ease-in-out infinite;
}
.plan-progress__step--done .plan-progress__dot {
  background: var(--success);
}
.plan-progress__step-idx {
  width: 16px;
  text-align: right;
  color: var(--text-3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.plan-progress__step--done .plan-progress__step-idx {
  color: var(--success);
}
.plan-progress__step-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-progress__step-done {
  color: var(--success);
  flex-shrink: 0;
}
@keyframes plan-progress-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
