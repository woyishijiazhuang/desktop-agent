<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NInput, NTag } from 'naive-ui'
import { HelpCircleOutline } from '@vicons/ionicons5'
import { useAskUserStore } from '@renderer/store/useAskUserStore'
import { useChatStore } from '@renderer/store/useChatStore'

/**
 * 澄清问题卡片：Agent 调用 ask_user 后展示在输入框上方。
 * 展示问题文本与预置选项（单选/多选），支持自由输入，作答/跳过回传给 Agent。
 */
const askUserStore = useAskUserStore()
const chatStore = useChatStore()

const current = computed(() => askUserStore.forSession(chatStore.currentSessionId))
/** 自由输入内容（未点选项时提交）。 */
const custom = ref('')
/** 单选：当前选中的 option value。 */
const selected = ref<string | null>(null)
/** 多选：当前选中的 option value 集合。 */
const selectedMulti = ref<string[]>([])

// 问题切换时重置作答状态
watch(current, () => {
  custom.value = ''
  selected.value = null
  selectedMulti.value = []
})

function toggleOption(value: string): void {
  if (!current.value) return
  if (current.value.multiSelect) {
    const i = selectedMulti.value.indexOf(value)
    if (i >= 0) selectedMulti.value.splice(i, 1)
    else selectedMulti.value.push(value)
  } else {
    selected.value = selected.value === value ? null : value
  }
}

/** 提交作答：单选/多选优先取选项值，否则取自由输入。 */
function onSubmit(): void {
  const sid = chatStore.currentSessionId
  if (!sid || !current.value) return
  if (current.value.multiSelect) {
    askUserStore.respond(
      sid,
      selectedMulti.value.length > 0 ? [...selectedMulti.value] : custom.value.trim() || null
    )
  } else {
    const value = selected.value ?? (custom.value.trim() || null)
    askUserStore.respond(sid, value)
  }
}

function onSkip(): void {
  const sid = chatStore.currentSessionId
  if (!sid) return
  askUserStore.respond(sid, null)
}
</script>

<template>
  <Transition name="ask-bar">
    <div v-if="current" class="ask-bar">
      <div class="ask-bar__head">
        <span class="ask-bar__title">
          <NIcon :size="14" class="ask-bar__icon"><HelpCircleOutline /></NIcon>
          AI 想确认：{{ current.question }}
        </span>
        <NTag size="tiny" type="info" :bordered="false">
          {{ current.multiSelect ? '可多选' : '单选' }}{{ current.required ? ' · 必答' : '' }}
        </NTag>
      </div>

      <div v-if="current.options.length > 0" class="ask-bar__options">
        <button
          v-for="opt in current.options"
          :key="opt.value"
          type="button"
          class="ask-bar__option"
          :class="{
            'ask-bar__option--active': current.multiSelect
              ? selectedMulti.includes(opt.value)
              : selected === opt.value
          }"
          @click="toggleOption(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>

      <div class="ask-bar__custom">
        <NInput
          v-model:value="custom"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 3 }"
          :placeholder="
            current.options.length > 0 ? '或在此自由输入其他答案…' : '在此输入你的答案…'
          "
          size="small"
          @keydown.enter.exact.prevent="onSubmit"
        />
      </div>

      <div class="ask-bar__actions">
        <NButton
          size="small"
          type="primary"
          :disabled="
            current.required && !custom.trim() && selected === null && selectedMulti.length === 0
          "
          @click="onSubmit"
        >
          提交
        </NButton>
        <NButton
          v-if="!current.required"
          size="small"
          title="跳过此题，AI 基于已有信息继续"
          @click="onSkip"
        >
          跳过
        </NButton>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.ask-bar {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ask-bar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ask-bar__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
}
.ask-bar__icon {
  color: var(--primary);
  flex-shrink: 0;
}
.ask-bar__options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-bar__option {
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  color: var(--text-2);
  background: transparent;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}
.ask-bar__option:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.ask-bar__option--active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.ask-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 出现/消失淡入淡出 */
.ask-bar-enter-active,
.ask-bar-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.ask-bar-enter-from,
.ask-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
