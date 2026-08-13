<script setup lang="ts">
import { computed, ref } from 'vue'
import { NIcon } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, DocumentTextOutline } from '@vicons/ionicons5'
import { useStickToBottomPause } from '@renderer/composables/useStickToBottomPause'

const props = defineProps<{
  /** 被压缩的消息条数（id <= compressLastIndex）。 */
  count: number
  /** 压缩摘要全文（展开时展示；无摘要时不渲染展开区）。 */
  summary: string | null
}>()

const expanded = ref(false)
const pauseStick = useStickToBottomPause()

/** 展开文案：有摘要时提示查看摘要，无摘要仅说明已压缩。 */
const hint = computed(() => (props.summary ? '点击展开摘要' : '摘要仅存在于模型上下文中'))

function toggle(): void {
  // 切换前解除粘底锁定，避免展开高度变化被当作流式增长强制滚底而闪烁
  pauseStick?.()
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="compress-divider">
    <div class="compress-divider__line" />
    <button type="button" class="compress-divider__tag" :title="hint" @click="toggle">
      <NIcon :size="14"><DocumentTextOutline /></NIcon>
      <span>以上 {{ count }} 条已压缩为摘要</span>
      <NIcon v-if="summary" :size="13" class="compress-divider__chevron">
        <ChevronUpOutline v-if="expanded" />
        <ChevronDownOutline v-else />
      </NIcon>
    </button>
    <div class="compress-divider__line" />
  </div>
  <div v-if="expanded && summary" class="compress-divider__summary">{{ summary }}</div>
</template>

<style scoped>
.compress-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0 4px;
}
.compress-divider__line {
  flex: 1;
  height: 1px;
  background: var(--border-soft);
}
.compress-divider__tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-soft);
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.compress-divider__tag:hover {
  color: var(--text-1);
  border-color: var(--primary);
  background: var(--hover-bg);
}
.compress-divider__chevron {
  color: var(--text-3);
}
.compress-divider__summary {
  margin: 2px 0 6px;
  padding: 10px 14px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
