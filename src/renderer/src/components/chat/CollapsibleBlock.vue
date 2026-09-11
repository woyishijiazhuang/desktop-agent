<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { NIcon } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'

/**
 * 通用可折叠内容块：图标 + 名称 + 动作文案 + Chevron 的卡片头，展开后显示等宽文本正文。
 * 用户消息中的文件块 / 技能块共用此结构，差异仅在图标、配色与文案，故收敛到本组件。
 */
const props = withDefaults(
  defineProps<{
    icon: Component
    name: string
    /** 展开体正文；为空时改显示 emptyHint（若有）。 */
    text?: string
    /** 配色：default（中性）/ accent（主题色强调，用于技能块）。 */
    variant?: 'default' | 'accent'
    /** 展开态动作文案。 */
    expandedAction?: string
    /** 有正文时的折叠态动作文案。 */
    collapsedAction?: string
    /** 无正文时的折叠态动作文案（缺省回退 collapsedAction）。 */
    emptyAction?: string
    /** 无正文时展开体的占位文案；未提供则展开体为空。 */
    emptyHint?: string
  }>(),
  {
    variant: 'default',
    expandedAction: '收起',
    collapsedAction: '查看内容'
  }
)

const expanded = ref(false)
const pauseStick = useStickToBottomPause()

/** 头部动作文案：展开固定「收起」，折叠时按有无正文区分。 */
const actionLabel = computed(() => {
  if (expanded.value) return props.expandedAction
  return props.text ? props.collapsedAction : (props.emptyAction ?? props.collapsedAction)
})

function toggle(): void {
  // 切换前解除粘底锁定，避免展开高度变化被当作流式增长强制滚底而闪烁
  pauseStick?.()
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="cb" :class="[`cb--${props.variant}`, { 'cb--open': expanded }]">
    <button type="button" class="cb__head" @click="toggle">
      <NIcon :size="16" class="cb__icon"><component :is="props.icon" /></NIcon>
      <span class="cb__name" :title="props.name">{{ props.name }}</span>
      <span class="cb__action">{{ actionLabel }}</span>
      <NIcon :size="14" class="cb__chevron">
        <ChevronDownOutline v-if="expanded" />
        <ChevronForwardOutline v-else />
      </NIcon>
    </button>
    <div v-if="expanded" class="cb__body">
      <pre v-if="props.text" class="cb__content">{{ props.text }}</pre>
      <p v-else-if="props.emptyHint" class="cb__empty">{{ props.emptyHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.cb {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-mute);
  overflow: hidden;
  margin-bottom: 6px;
  max-width: 480px;
}
.cb--accent {
  border-color: color-mix(in srgb, var(--primary) 35%, var(--border));
  background: color-mix(in srgb, var(--primary) 6%, var(--bg-mute));
}
.cb__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
}
.cb__head:hover {
  background: var(--border-soft);
}
.cb--accent .cb__head:hover {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.cb__icon {
  color: var(--primary);
  flex-shrink: 0;
}
.cb__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.cb__action {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}
.cb__chevron {
  color: var(--text-3);
  flex-shrink: 0;
}
.cb__body {
  border-top: 1px solid var(--border);
  background: var(--color-background);
}
.cb__content {
  margin: 0;
  padding: 10px;
  max-height: 300px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.6;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}
.cb__empty {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
