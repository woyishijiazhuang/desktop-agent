<script setup lang="ts">
import { ref } from 'vue'
import { NIcon } from 'naive-ui'
import { DocumentTextOutline, ChevronDownOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'

/**
 * 用户消息中的文件内容块（type=text + file_name）：
 * 默认折叠为「文件名 + 查看内容」卡片，点击展开解析后的文本（max-height 滚动）。
 * 文件内容独立成块后不再混入用户正文，正文只显示用户输入。
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
  <div class="ufile" :class="{ 'ufile--open': expanded }">
    <button type="button" class="ufile__head" @click="toggle">
      <NIcon :size="16" class="ufile__icon"><DocumentTextOutline /></NIcon>
      <span class="ufile__name" :title="props.name">{{ props.name }}</span>
      <span class="ufile__action">{{ expanded ? '收起' : '查看内容' }}</span>
      <NIcon :size="14" class="ufile__chevron">
        <ChevronDownOutline v-if="expanded" />
        <ChevronForwardOutline v-else />
      </NIcon>
    </button>
    <div v-if="expanded" class="ufile__body">
      <pre class="ufile__content">{{ props.text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.ufile {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-mute);
  overflow: hidden;
  margin-bottom: 6px;
  max-width: 480px;
}
.ufile__head {
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
.ufile__head:hover {
  background: var(--border-soft);
}
.ufile__icon {
  color: var(--primary);
  flex-shrink: 0;
}
.ufile__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
}
.ufile__action {
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}
.ufile__chevron {
  color: var(--text-3);
  flex-shrink: 0;
}
.ufile__body {
  border-top: 1px solid var(--border);
  background: var(--color-background);
}
.ufile__content {
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
</style>
