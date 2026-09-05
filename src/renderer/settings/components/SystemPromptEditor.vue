<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { NButton, NSpace } from 'naive-ui'
import { buildDefaultSystemPrompt } from '@main/agent/types'

const props = defineProps<{ modelValue: string; saving?: boolean }>()
const emit = defineEmits<{ save: [value: string] }>()

/** 本地草稿：编辑时不直接改父组件状态，点保存才提交。 */
const draft = ref(props.modelValue)
/**
 * placeholder 直接展示内置默认提示词的完整内容：
 * 留空时用户即可看到实际生效的默认文本，而非仅一句「使用了默认」的告知。
 * 环境信息（OS/时间）在组件创建时生成即可。
 */
const PLACEHOLDER = buildDefaultSystemPrompt()

// 自绘 textarea：高度随内容增高（原 naive NInput autosize 依赖 ResizeObserver，
// 与设置内容区的 NScrollbar 相互响应会在帧内循环，触发浏览器
// "ResizeObserver loop completed with undelivered notifications" 告警，故弃用）。
const textareaEl = ref<HTMLTextAreaElement | null>(null)

function autosize(): void {
  const el = textareaEl.value
  if (!el) return
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

function onInput(e: Event): void {
  draft.value = (e.target as HTMLTextAreaElement).value
  autosize()
}

// 外部更新（loadSettings 完成 / 保存后回写）时同步草稿并重算高度
watch(
  () => props.modelValue,
  async (v) => {
    draft.value = v
    await nextTick()
    autosize()
  }
)

onMounted(autosize)

function onSave(): void {
  emit('save', draft.value)
}

function onReset(): void {
  draft.value = ''
  emit('save', '')
}
</script>

<template>
  <div class="prompt-editor">
    <textarea
      ref="textareaEl"
      class="prompt-editor__textarea"
      :value="draft"
      :placeholder="PLACEHOLDER"
      spellcheck="false"
      @input="onInput"
    ></textarea>
    <NSpace justify="end" class="prompt-editor__actions">
      <NButton @click="onReset">恢复默认</NButton>
      <NButton
        type="primary"
        :loading="props.saving"
        :disabled="draft === props.modelValue"
        @click="onSave"
      >
        保存
      </NButton>
    </NSpace>
  </div>
</template>

<style scoped>
.prompt-editor__actions {
  margin-top: 8px;
}
.prompt-editor__textarea {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 140px; /* 约 6 行，与原先 autosize minRows 对齐 */
  max-height: 360px; /* 约 16 行封顶，超出后内部滚动，避免撑得过高 */
  overflow-y: auto;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
  resize: none;
  outline: none;
}
.prompt-editor__textarea::placeholder {
  color: var(--text-3);
}
.prompt-editor__textarea:focus {
  border-color: var(--primary);
}
</style>
