<script setup lang="ts">
import { ref, watch } from 'vue'
import { NInput, NButton, NSpace } from 'naive-ui'
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

// 父组件外部更新（如 loadSettings 完成后）时同步草稿
watch(
  () => props.modelValue,
  (v) => {
    draft.value = v
  }
)

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
    <NInput
      v-model:value="draft"
      type="textarea"
      :placeholder="PLACEHOLDER"
      :autosize="{ minRows: 6 }"
      spellcheck="false"
    />
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
</style>
