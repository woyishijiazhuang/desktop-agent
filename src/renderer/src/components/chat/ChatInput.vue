<script setup lang="ts">
import { h, ref, computed, watch, onMounted, type VNodeChild } from 'vue'
import {
  NInput,
  NButton,
  NSelect,
  NIcon,
  NTag,
  NDropdown,
  useMessage,
  type SelectOption,
  type DropdownOption
} from 'naive-ui'
import {
  SendOutline,
  StopCircleOutline,
  ImageOutline,
  DocumentTextOutline,
  CloseOutline,
  ExtensionPuzzleOutline
} from '@vicons/ionicons5'
import { useChatStore, type ComposerAttachment } from '@renderer/store/useChatStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { useSettingsStore, THINKING_LEVEL_OPTIONS } from '@renderer/store/useSettingsStore'
import { useAttachments } from '@renderer/composables/useAttachments'
import { mainClient } from '@renderer/utils/main-client'
import type { ThinkingLevel, InstalledSkill } from '@main/agent/types'
import { formatModelKey, isThinkingLevel, parseModelKey } from '@main/agent/types'

const props = defineProps<{ isBusy: boolean }>()
const emit = defineEmits<{
  send: [text: string, attachments?: ComposerAttachment[], skills?: string[]]
  abort: []
}>()
const text = ref('')

const chatStore = useChatStore()
const modelConfigs = useModelConfigsStore()
const settings = useSettingsStore()
const message = useMessage()
const fileInputRef = ref<HTMLInputElement | null>(null)

/** 模型选择器当前值（ModelKey JSON 字符串）。 */
const modelValue = computed(() =>
  chatStore.currentModelKey ? formatModelKey(chatStore.currentModelKey) : null
)

/** 全部已配置模型作为选项（value = ModelKey JSON 字符串，multimodal 供下拉标签渲染）。 */
const modelOptions = computed(() =>
  modelConfigs.configs.map((c) => ({
    label: c.displayName,
    value: formatModelKey({ provider: c.id, id: c.modelId }),
    multimodal: c.multimodal
  }))
)

/** 下拉选项渲染：模型名 + 多模态标签（切换时可直观判断该模型是否支持图片）。 */
function renderModelLabel(option: SelectOption): VNodeChild {
  return h('span', { class: 'model-option' }, [
    h('span', { class: 'model-option__name' }, option.label as string),
    option.multimodal
      ? h(NTag, { size: 'tiny', round: true, type: 'info' }, { default: () => '多模态' })
      : null
  ])
}

function onModelChange(val: string | null): void {
  if (!val) return
  const key = parseModelKey(val)
  if (key) void chatStore.selectModel(key)
}

// ---- 思考模式：强度列表（含「关闭」） ----

/** 当前会话思考级别（'off' = 关闭思考）。 */
const thinkingLevel = computed<ThinkingLevel>(() => chatStore.currentThinkingLevel)
/** 强度下拉选项（useSettingsStore 导出，含「关闭」）。 */
const thinkingLevelOptions = THINKING_LEVEL_OPTIONS

/** 选中模型不支持推理时禁用思考控制（未选模型不限制）。 */
const thinkingDisabled = computed(() => {
  const c = modelConfigs.findConfig(chatStore.currentModelKey)
  return c ? c.reasoning === false : false
})

/** 当前选中的模型配置（判断能力用）。 */
const currentModel = computed(() => modelConfigs.findConfig(chatStore.currentModelKey))

/** 当前模型不支持多模态时禁用图片输入（未选模型不限制）。 */
const imageDisabled = computed(() => {
  const c = currentModel.value
  return c ? !c.multimodal : false
})

/** 附件管理（拖拽 / 粘贴 / 选择收集，图片受模型多模态能力约束）。 */
const { attachments, dragOver, onDrop, onPaste, onFileInputChange, removeAttachment } =
  useAttachments({ imageDisabled: () => imageDisabled.value, message })

// ---- 技能选择（单次生效：发送后清空） ----
/** 已安装技能列表（打开下拉时刷新）。 */
const installedSkills = ref<InstalledSkill[]>([])
/** 本次待发送选中的技能（id + 展示名）。 */
const selectedSkills = ref<{ id: string; name: string }[]>([])

/** 已启用技能列表（停用技能不在聊天框展示，与「停用 = 彻底不可用」语义一致）。 */
const enabledSkills = computed(() => installedSkills.value.filter((s) => s.enabled))

/** 下拉选项：技能名 + 版本（NDropdown 以 key 为标识，@select 返回 key）。 */
const skillOptions = computed<DropdownOption[]>(() =>
  enabledSkills.value.map((s) => ({
    label: s.name || s.id,
    key: s.id,
    value: s.id
  }))
)

/** 选中技能对应展示名（渲染 chips 用）。 */
function skillName(id: string): string {
  return enabledSkills.value.find((s) => s.id === id)?.name || id
}

/** 下拉选项渲染：技能名 + 已选对勾（点击已选项可取消）。 */
function renderSkillLabel(option: DropdownOption): VNodeChild {
  const checked = selectedSkills.value.some((s) => s.id === option.key)
  return h('div', { class: 'skill-option' }, [
    h('span', { class: 'skill-option__name' }, option.label as string),
    checked ? h('span', { class: 'skill-option__check' }, '✓') : null
  ])
}

/** 下拉选择/取消：重复选中则移除（toggle），否则加入。 */
function onSkillSelect(key: string | number): void {
  const id = String(key)
  const idx = selectedSkills.value.findIndex((s) => s.id === id)
  if (idx >= 0) selectedSkills.value.splice(idx, 1)
  else selectedSkills.value.push({ id, name: skillName(id) })
}

/** 移除已选技能 chip。 */
function removeSkill(id: string): void {
  selectedSkills.value = selectedSkills.value.filter((s) => s.id !== id)
}

/** 刷新已安装技能列表（Agent 可能在对话中安装/卸载技能，列表需跟上）。 */
async function reloadSkills(): Promise<void> {
  try {
    installedSkills.value = await mainClient.agent.listInstalledSkills()
  } catch {
    // 刷新失败保留旧列表，不打断用户操作
  }
}

/** 技能按钮点击：先刷新列表（新安装的技能立即可见），无可选技能时给出引导提示。 */
async function onSkillButtonClick(): Promise<void> {
  if (props.isBusy || !settings.skillsEnabled) return
  await reloadSkills()
  if (skillOptions.value.length === 0) {
    message.info('暂无可用技能。可到「设置 → 技能」页搜索安装，或直接让 Agent 用 find_skill 搜索')
  }
}

/** 下拉每次展开时也刷新一次，保证菜单内是最近列表。 */
function onSkillMenuShow(show: boolean): void {
  if (show) void reloadSkills()
}

/** 技能总开关关闭时清空已选技能（控制同时禁用，避免残留选择被发送）。 */
watch(
  () => settings.skillsEnabled,
  (v) => {
    if (!v) selectedSkills.value = []
  }
)

/** 某个技能被停用（或列表刷新后不再启用）时，将其从已选中剔除。 */
watch(
  enabledSkills,
  (skills) => {
    const ids = new Set(skills.map((s) => s.id))
    selectedSkills.value = selectedSkills.value.filter((s) => ids.has(s.id))
  }
)

onMounted(() => {
  void mainClient.agent.listInstalledSkills().then((list) => {
    installedSkills.value = list
  })
})

function onThinkingLevelChange(val: string | null): void {
  if (!isThinkingLevel(val)) return
  void chatStore.selectThinkingLevel(val)
}

// 未选模型时按钮仍可点，点击触发 store 提示（文本保留在输入框，不吞消息）
const canSend = computed(
  () =>
    !props.isBusy &&
    (text.value.trim().length > 0 ||
      attachments.value.length > 0 ||
      selectedSkills.value.length > 0)
)

/** 输入字符计数（仅非空时显示，避免视觉噪音）。 */
const charCount = computed(() => {
  const n = text.value.length
  return n > 0 ? n : null
})

// 回收（编辑）失败消息：store 把文本塞进 prefillText，此处消费回填输入框
watch(
  () => chatStore.prefillText,
  (val) => {
    if (val) {
      text.value = val
      chatStore.prefillText = ''
    }
  }
)

function submit(): void {
  if (props.isBusy) return
  const value = text.value.trim()
  if (value.length === 0 && attachments.value.length === 0 && selectedSkills.value.length === 0)
    return
  // 技能总开关关闭时技能选择控件已禁用；此处兜底忽略残留选中，避免把技能块发给 Agent
  const skillIds = settings.skillsEnabled ? selectedSkills.value.map((s) => s.id) : []
  // 未选择模型：不消费输入（文本与附件/技能保留），由 store 提示「请先选择模型」
  if (!chatStore.currentModelKey) {
    void chatStore.send(value, attachments.value, skillIds)
    return
  }
  // 当前模型不支持多模态：禁止发送图片（附件保留，提示切换模型或移除图片）
  if (imageDisabled.value && attachments.value.some((a) => a.kind === 'image')) {
    message.warning('当前模型不支持图片，请切换支持多模态的模型或移除图片')
    return
  }
  emit('send', value, attachments.value, skillIds)
  text.value = ''
  attachments.value = []
  // 技能单次生效：发送后清空选择
  selectedSkills.value = []
}

function onStop(): void {
  emit('abort')
}

function onKeydown(e: KeyboardEvent): void {
  // 输入法组词中（如中文选词回车/取消）的按键不参与快捷键处理，
  // 否则选词回车会误触发发送、取消组词 Esc 会误中止生成
  if (e.isComposing || e.keyCode === 229) return
  // Esc：运行中则中止
  if (e.key === 'Escape' && props.isBusy) {
    e.preventDefault()
    onStop()
    return
  }
  // Enter 发送，Shift+Enter 换行；Cmd/Ctrl+Enter 也可发送
  if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div
    class="composer"
    :class="{ 'composer--busy': isBusy, 'composer--dragover': dragOver }"
    @dragover.prevent="dragOver = true"
    @dragleave.prevent="dragOver = false"
    @drop="onDrop"
  >
    <!-- 待发送技能预览：已选技能 chip，可单独移除 -->
    <div v-if="selectedSkills.length > 0" class="composer__skills">
      <NTag
        v-for="s in selectedSkills"
        :key="s.id"
        size="small"
        round
        :bordered="false"
        type="primary"
        class="composer__skill"
      >
        <template #icon>
          <NIcon :size="12"><ExtensionPuzzleOutline /></NIcon>
        </template>
        <span class="composer__skill-name">{{ s.name }}</span>
        <button
          class="composer__skill-remove"
          type="button"
          title="移除技能"
          @click="removeSkill(s.id)"
        >
          <NIcon :size="11"><CloseOutline /></NIcon>
        </button>
      </NTag>
    </div>

    <!-- 待发送附件预览：图片缩略图 / 文本文件 chip，可单独移除 -->
    <div v-if="attachments.length > 0" class="composer__attachments">
      <div v-for="att in attachments" :key="att.id" class="composer__attachment">
        <img
          v-if="att.kind === 'image' && att.dataUrl"
          :src="att.dataUrl"
          class="composer__attachment-img"
          alt=""
        />
        <NIcon v-else class="composer__attachment-icon"><DocumentTextOutline /></NIcon>
        <span class="composer__attachment-name" :title="att.name">{{ att.name }}</span>
        <button
          class="composer__attachment-remove"
          type="button"
          title="移除附件"
          @click="removeAttachment(att.id)"
        >
          <NIcon :size="12"><CloseOutline /></NIcon>
        </button>
      </div>
    </div>

    <NInput
      v-model:value="text"
      class="composer__input"
      type="textarea"
      :autosize="{ minRows: 1, maxRows: 8 }"
      :bordered="false"
      :placeholder="
        isBusy ? '生成中…（Esc 中止）' : '输入消息…（Enter 发送，可拖拽/粘贴图片或文件）'
      "
      @keydown="onKeydown"
      @paste="onPaste"
    />

    <!-- 底部工具条：附件 + 模型选择 + 思考控制（左）+ 发送 / 中止（右） -->
    <div class="composer__bar">
      <div class="composer__left">
        <input
          ref="fileInputRef"
          type="file"
          multiple
          hidden
          accept="image/*,.txt,.md,.json,.js,.ts,.py,.html,.css,.xml,.csv,.log,.yml,.yaml,.ini,.toml,.docx,.pdf,.xlsx,.pptx"
          @change="onFileInputChange"
        />
        <NButton
          quaternary
          circle
          size="small"
          class="composer__attach"
          :title="
            imageDisabled ? '当前模型不支持图片，请切换支持多模态的模型' : '添加图片或文本文件'
          "
          :disabled="isBusy || imageDisabled"
          @click="fileInputRef?.click()"
        >
          <template #icon>
            <NIcon><ImageOutline /></NIcon>
          </template>
        </NButton>
        <!-- 技能选择：点按钮展开已启用技能，多选 chips；点击已选项可取消。
             技能总开关关闭（settings.skillsEnabled）时禁用，与 Agent 工具注入保持一致。
             无可选技能时不展开空下拉，点击给出引导提示 -->
        <NDropdown
          :options="skillOptions"
          :render-label="renderSkillLabel"
          trigger="click"
          :disabled="isBusy || !settings.skillsEnabled || skillOptions.length === 0"
          placement="top-start"
          @select="onSkillSelect"
          @update:show="onSkillMenuShow"
        >
          <NButton
            quaternary
            circle
            size="small"
            class="composer__attach"
            title="选择技能（点击已选项可取消）"
            :disabled="isBusy || !settings.skillsEnabled"
            @click="onSkillButtonClick"
          >
            <template #icon>
              <NIcon><ExtensionPuzzleOutline /></NIcon>
            </template>
          </NButton>
        </NDropdown>
        <NSelect
          :value="modelValue"
          :options="modelOptions"
          :render-label="renderModelLabel"
          size="small"
          :bordered="false"
          placeholder="选择模型"
          class="composer__model"
          :class="{ 'composer__control--locked': isBusy }"
          @update:value="onModelChange"
        />
        <div
          class="composer__thinking"
          :class="{
            'composer__thinking--disabled': thinkingDisabled,
            'composer__control--locked': isBusy
          }"
        >
          <span class="composer__thinking-label">思考</span>
          <NSelect
            :value="thinkingLevel"
            :options="thinkingLevelOptions"
            :disabled="thinkingDisabled"
            size="small"
            :bordered="false"
            class="composer__thinking-level"
            @update:value="onThinkingLevelChange"
          />
        </div>
      </div>
      <div class="composer__right">
        <span v-if="charCount !== null" class="composer__count">{{ charCount }}</span>
        <NButton
          v-if="!isBusy"
          class="composer__send"
          type="primary"
          circle
          :disabled="!canSend"
          title="发送（Enter）"
          @click="submit"
        >
          <template #icon>
            <NIcon><SendOutline /></NIcon>
          </template>
        </NButton>
        <NButton
          v-else
          class="composer__send"
          type="error"
          circle
          title="中止生成（Esc）"
          @click="onStop"
        >
          <template #icon>
            <NIcon><StopCircleOutline /></NIcon>
          </template>
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg);
  box-shadow: var(--shadow-sm);
  padding: 6px 8px 6px;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.composer:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
}
.composer--busy {
  border-color: var(--border);
}
.composer--dragover {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-soft);
  background: var(--primary-soft);
}
/* 附件预览条 */
.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 4px 6px;
}
/* 技能选择 chips 条 */
.composer__skills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 4px 2px;
}
.composer__skill {
  --n-color: color-mix(in srgb, var(--primary) 12%, transparent) !important;
  padding-right: 2px;
}
.composer__skill-name {
  margin-right: 2px;
}
.composer__skill-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.composer__skill-remove:hover {
  background: var(--error-soft);
  color: var(--error);
}
/* 技能下拉选项：名称 + 已选对勾 */
.skill-option {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-width: 160px;
}
.skill-option__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-option__check {
  color: var(--primary);
  flex-shrink: 0;
}
.composer__attachment {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.composer__attachment-img {
  width: 30px;
  height: 30px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}
.composer__attachment-icon {
  color: var(--text-3);
  font-size: 20px;
  flex-shrink: 0;
}
.composer__attachment-name {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.composer__attachment-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.composer__attachment-remove:hover {
  background: var(--error-soft);
  color: var(--error);
}
.composer__attach {
  --n-size: 28px;
  color: var(--text-3);
}
.composer__attach:hover {
  color: var(--primary);
}
.composer__input {
  /* 让 NInput 无边框后铺满，行高舒适 */
  font-size: 14px;
}
/* Naive 占位符是独立元素，需与文本区同步设置内边距/行高，
   否则输入光标会相对占位符错位（光标压到首个字符上）。
   水平内边距由 .n-input-wrapper 统一提供，这里只调垂直方向。 */
.composer__input :deep(.n-input__textarea-el),
.composer__input :deep(.n-input__placeholder),
.composer__input :deep(.n-input__textarea-mirror) {
  padding: 6px 0;
  line-height: 1.6;
}
.composer__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 0;
}
.composer__left {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.composer__model {
  width: 220px;
  max-width: 45%;
}
/* 思考控制：标签 + 强度下拉（同设置页，含「关闭」） */
.composer__thinking {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.composer__thinking--disabled {
  opacity: 0.55;
}
/* 忙碌时仅阻断点击，不改外观（不加禁用态样式） */
.composer__control--locked {
  pointer-events: none;
}
.composer__thinking-label {
  font-size: 12px;
  color: var(--text-3);
  user-select: none;
}
.composer__thinking-level {
  width: 92px;
}
/* 统一内层控件聚焦表现：
   - 文字输入框：聚焦不做背景变色（亮/暗保持一致），仅保留统一的紫色光环
   - 两个 select：聚焦/展开为紫色淡染背景 + 紫色光环（替代 naive 亮色白底无感、暗色紫底+8px 光晕的差异）
   注意：输入框变量内联在 .n-input 根元素（即 .composer__input 自身），须直接作用于该元素；
   select 变量内联在子元素 .n-base-selection 上，用 :deep 后代选择器。均需 !important 压过内联。 */
.composer__input {
  /* 聚焦背景 = 输入框自身背景（任何主题都不变色），仅保留紫色光环 */
  --n-color-focus: var(--n-color) !important;
  --n-box-shadow-focus: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent) !important;
}
.composer__model :deep(.n-base-selection),
.composer__thinking-level :deep(.n-base-selection) {
  --n-color-focus: color-mix(in srgb, var(--primary) 8%, var(--bg)) !important;
  --n-color-active: color-mix(in srgb, var(--primary) 8%, var(--bg)) !important;
  --n-box-shadow-focus: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent) !important;
}
/* select 选中值文字：默认更淡（--text-3，接近占位符），hover/聚焦时加深为 --text-2 提供反馈 */
.composer__model :deep(.n-base-selection),
.composer__thinking-level :deep(.n-base-selection) {
  --n-text-color: var(--text-3) !important;
}
.composer__model :deep(.n-base-selection:hover),
.composer__model :deep(.n-base-selection--focus),
.composer__thinking-level :deep(.n-base-selection:hover),
.composer__thinking-level :deep(.n-base-selection--focus) {
  --n-text-color: var(--text-2) !important;
}
.composer__right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.composer__count {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  min-width: 16px;
  text-align: right;
}
.composer__send {
  flex-shrink: 0;
}
</style>

<style>
/* 模型下拉选项：名称 + 多模态标签（避免超长名称撑破布局）。
   注意：本块为非 scoped。.model-option 由 render-label 在 naive-ui 内部
   （选中值 / 下拉菜单）渲染，元素不带本组件 scopeId，scoped 样式无法命中。 */
.model-option {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
}
.model-option__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-option__name + .n-tag {
  flex-shrink: 0;
}
</style>
