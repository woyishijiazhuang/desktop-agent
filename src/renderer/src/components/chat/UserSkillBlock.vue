<script setup lang="ts">
import { ref } from 'vue'
import { NIcon } from 'naive-ui'
import {
  ExtensionPuzzleOutline,
  ChevronDownOutline,
  ChevronForwardOutline
} from '@vicons/ionicons5'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'

/**
 * 用户消息中的技能内容块（type=text + skill_name）：
 * 展示为「技能名」卡片，点击展开 SKILL.md 全文（main 侧落库时填充）。
 * 技能全文独立成块后不混入用户正文，正文只显示用户输入。
 */
const props = defineProps<{ name: string; text: string }>()

const expanded = ref(false)
const pauseStick = useStickToBottomPause()

function toggle(): void {
  // 切换前解除粘底锁定，避免展开高度变化被当作流式增长强制滚底而闪烁
  pauseStick?.()
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="uskill" :class="{ 'uskill--open': expanded }">
    <button type="button" class="uskill__head" @click="toggle">
      <NIcon :size="16" class="uskill__icon"><ExtensionPuzzleOutline /></NIcon>
      <span class="uskill__name" :title="props.name">{{ props.name }}</span>
      <span class="uskill__action">
        {{ expanded ? '收起' : props.text ? '查看技能说明' : '技能已附加' }}
      </span>
      <NIcon :size="14" class="uskill__chevron">
        <ChevronDownOutline v-if="expanded" />
        <ChevronForwardOutline v-else />
      </NIcon>
    </button>
    <div v-if="expanded" class="uskill__body">
      <pre v-if="props.text" class="uskill__content">{{ props.text }}</pre>
      <p v-else class="uskill__empty">技能说明已随消息发送给模型。</p>
    </div>
  </div>
</template>

<style scoped>
.uskill {
  border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--primary) 6%, var(--bg-mute));
  overflow: hidden;
  margin-bottom: 6px;
  max-width: 480px;
}
.uskill__head {
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
.uskill__head:hover {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.uskill__icon {
  color: var(--primary);
  flex-shrink: 0;
}
.uskill__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.uskill__action {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}
.uskill__chevron {
  color: var(--text-3);
  flex-shrink: 0;
}
.uskill__body {
  border-top: 1px solid var(--border);
  background: var(--color-background);
}
.uskill__content {
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
.uskill__empty {
  margin: 0;
  padding: 10px;
  font-size: 12px;
  color: var(--text-3);
}
</style>
