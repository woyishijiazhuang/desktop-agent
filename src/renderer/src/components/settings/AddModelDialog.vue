<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import {
  NModal,
  NRadioGroup,
  NRadioButton,
  NSelect,
  NInput,
  NInputNumber,
  NSwitch,
  NButton,
  NCollapse,
  NCollapseItem,
  NSpace,
  NAlert,
  NTimePicker,
  useMessage
} from 'naive-ui'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { mainClient } from '@renderer/utils/main-client'
import type {
  ModelConfigSummary,
  CreateModelConfigInput,
  UpdateModelConfigInput,
  ApiFormat,
  PresetModelInfo,
  ModelPricing
} from '@main/agent/types'

const props = defineProps<{ show: boolean; editing?: ModelConfigSummary | null }>()
const emit = defineEmits<{ 'update:show': [value: boolean] }>()

const store = useModelConfigsStore()
const message = useMessage()

const isEdit = computed(() => !!props.editing)

interface PeakPeriodForm {
  /** 时段起始（NTimePicker 值：当日秒级时间戳，仅取 HH:mm） */
  start: number
  /** 时段结束（NTimePicker 值：当日秒级时间戳，仅取 HH:mm） */
  end: number
  /** 高峰倍率 */
  multiplier: number
}

interface FormState {
  mode: 'preset' | 'custom'
  presetProvider: string
  modelSelectMode: 'catalog' | 'custom'
  modelId: string
  apiFormat: ApiFormat
  baseUrl: string
  apiKey: string
  displayName: string
  contextWindow: number
  maxTokens: number
  multimodal: boolean
  reasoning: boolean
  pricingEnabled: boolean
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number
  peakPricing: boolean
  peakPeriods: PeakPeriodForm[]
}

/** 本地时间分钟 → NTimePicker 值（当日秒级时间戳）。 */
function minutesToTime(minutes: number): number {
  const d = new Date()
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** NTimePicker 值（秒级时间戳）→ 本地时间分钟。 */
function timeToMinutes(sec: number): number {
  const d = new Date(sec * 1000)
  return d.getHours() * 60 + d.getMinutes()
}

/** 把存储形态的定价转换为表单时段。 */
function periodsToForm(
  periods: { startMinutes: number; endMinutes: number; multiplier: number }[]
): PeakPeriodForm[] {
  return periods.map((p) => ({
    start: minutesToTime(p.startMinutes),
    end: minutesToTime(p.endMinutes),
    multiplier: p.multiplier
  }))
}

/** 最大输出 Tokens 默认值：非推理模型 4096；推理模型的思考 tokens 计入输出上限，默认给足预算，
 * 避免长思考在 max_tokens 处被截断（finish_reason='length'、正文为空，表现为"思考没完就停了"）。 */
const DEFAULT_MAX_TOKENS = 4096
const REASONING_MAX_TOKENS = 16384

const form = reactive<FormState>({
  mode: 'preset',
  presetProvider: '',
  modelSelectMode: 'catalog',
  modelId: '',
  apiFormat: 'openai-completions',
  baseUrl: '',
  apiKey: '',
  displayName: '',
  contextWindow: 8192,
  maxTokens: 4096,
  multimodal: false,
  reasoning: false,
  pricingEnabled: false,
  inputPrice: 0,
  outputPrice: 0,
  cacheReadPrice: 0,
  cacheWritePrice: 0,
  peakPricing: false,
  peakPeriods: []
})

const onlineModels = ref<PresetModelInfo[]>([])
const refreshing = ref(false)
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; error?: string } | null>(null)

const dialogTitle = computed(() => (isEdit.value ? '编辑模型' : '添加模型'))

/** 当前预置服务商信息（取 getKeyUrl）。 */
const currentPreset = computed(() =>
  store.presetProviders.find((p) => p.id === form.presetProvider)
)

/** 预置服务商选择器选项。 */
const providerOptions = computed(() =>
  store.presetProviders.map((p) => ({ label: p.name, value: p.id }))
)

/** 模型下拉选项：只取在线拉取结果（在线模型全量替换本地 catalog，任何时候不使用本地配置）。 */
const catalogOptions = computed(() => {
  const options = onlineModels.value.map((m) => ({ label: m.name, value: m.id }))
  // 编辑回显兜底：当前模型不在在线列表中时补一项，避免下拉框空白
  if (isEdit.value && form.modelId && !onlineModels.value.some((x) => x.id === form.modelId)) {
    options.push({ label: `${form.modelId}（不在服务商列表中）`, value: form.modelId })
  }
  return options
})

const apiFormatOptions = [
  { label: 'OpenAI Chat Completions', value: 'openai-completions' as ApiFormat },
  { label: 'Anthropic Messages', value: 'anthropic-messages' as ApiFormat }
]

/** 选中的在线模型（用于派生实际生效的 apiFormat）。 */
const selectedOnlineModel = computed(
  () => onlineModels.value.find((m) => m.id === form.modelId) ?? undefined
)

/** 实际生效的 apiFormat。preset 模式从在线模型或服务商首个在线模型派生。 */
const effectiveApiFormat = computed<ApiFormat>(() => {
  if (form.mode === 'custom') return form.apiFormat
  if (form.modelSelectMode === 'catalog' && selectedOnlineModel.value) {
    return selectedOnlineModel.value.api
  }
  return onlineModels.value[0]?.api ?? 'openai-completions'
})

/** 校验：能否保存。 */
const canSave = computed(() => {
  if (saving.value) return false
  if (form.mode === 'preset') {
    if (!form.presetProvider || !form.modelId.trim()) return false
  } else {
    if (!form.baseUrl.trim() || !form.modelId.trim()) return false
  }
  // 新建必须填 key；编辑可不填（留空=不变）
  if (!isEdit.value && !form.apiKey.trim()) return false
  return true
})

/** 初始化表单：编辑模式预填，否则默认值。 */
function initForm(): void {
  testResult.value = null
  onlineModels.value = []
  if (props.editing) {
    const e = props.editing
    form.mode = e.source
    form.presetProvider = e.presetProvider ?? ''
    form.modelSelectMode = 'catalog'
    form.modelId = e.modelId
    form.apiFormat = e.apiFormat
    form.baseUrl = e.baseUrl ?? ''
    form.apiKey = ''
    form.displayName = e.displayName
    form.contextWindow = e.contextWindow
    form.maxTokens = e.maxTokens
    form.multimodal = e.multimodal
    form.reasoning = e.reasoning
    applyPricingToForm(e.pricing)
    // 编辑模式不再加载本地 catalog；模型列表统一由 refreshOnline 从服务商在线拉取
  } else {
    form.mode = 'preset'
    form.presetProvider = ''
    form.modelSelectMode = 'catalog'
    form.modelId = ''
    form.apiFormat = 'openai-completions'
    form.baseUrl = ''
    form.apiKey = ''
    form.displayName = ''
    form.contextWindow = 8192
    form.maxTokens = 4096
    form.multimodal = false
    form.reasoning = false
    form.pricingEnabled = false
    form.inputPrice = 0
    form.outputPrice = 0
    form.cacheReadPrice = 0
    form.cacheWritePrice = 0
    form.peakPricing = false
    form.peakPeriods = []
  }
}

/** 把存储的定价写入表单。 */
function applyPricingToForm(pricing: ModelPricing | null): void {
  form.pricingEnabled = !!pricing
  form.inputPrice = pricing?.input ?? 0
  form.outputPrice = pricing?.output ?? 0
  form.cacheReadPrice = pricing?.cacheRead ?? 0
  form.cacheWritePrice = pricing?.cacheWrite ?? 0
  form.peakPricing = !!pricing?.peakPeriods?.length
  form.peakPeriods = pricing?.peakPeriods?.length ? periodsToForm(pricing.peakPeriods) : []
}

// 弹窗打开时初始化 + 确保预置服务商已加载
watch(
  () => props.show,
  async (show) => {
    if (show) {
      if (store.presetProviders.length === 0) await store.loadPresetProviders()
      initForm()
      // 编辑预置模型：优先用已存 key 自动拉取在线列表回显
      if (isEdit.value && props.editing?.source === 'preset' && props.editing?.hasApiKey) {
        void refreshOnline()
      }
    }
  }
)

// 切换预置服务商：清空模型选择与在线列表；已有可用 key 则重新拉取
// （编辑模式下服务商锁定，打开时的拉取统一走 show watch 的 refreshOnline）
watch(
  () => form.presetProvider,
  () => {
    if (form.mode !== 'preset' || isEdit.value) return
    form.modelId = ''
    onlineModels.value = []
    if (form.apiKey.trim()) {
      void refreshOnline()
    }
  }
)

// 用户填写 API key 后自动尝试拉取（防抖）
let fetchTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => form.apiKey,
  (key) => {
    if (fetchTimer) clearTimeout(fetchTimer)
    if (form.mode !== 'preset' || !form.presetProvider) return
    if (!key.trim()) {
      if (!isEdit.value) onlineModels.value = []
      return
    }
    fetchTimer = setTimeout(() => void refreshOnline(), 500)
  }
)

// 选中在线模型：预填高级配置（仅新增模式；编辑模式保留已存值）。
// 仅 Anthropic 等返回 capabilities 的服务商能提供元数据，其余留默认值由用户补充。
watch(
  () => form.modelId,
  (id) => {
    if (isEdit.value) return
    if (form.mode !== 'preset' || form.modelSelectMode !== 'catalog') return
    const m = onlineModels.value.find((x) => x.id === id)
    if (!m) return
    if (m.contextWindow) form.contextWindow = m.contextWindow
    if (m.multimodal) form.multimodal = true
    if (m.reasoning) form.reasoning = true
    if (!form.displayName.trim()) form.displayName = m.name
    // 推理模型：思考 tokens 计入 max_tokens 上限，选中时若仍是默认值则放大输出预算，
    // 避免长思考在 max_tokens 处被截断（finish_reason='length'、正文为空）。
    if (m.reasoning && form.maxTokens <= DEFAULT_MAX_TOKENS) form.maxTokens = REASONING_MAX_TOKENS
  }
)

// 手动开启「推理」开关（自定义模式 / 手动输入模型 ID / 预置模式切开关）：
// 与选中推理模型同策略放大输出预算，仅在仍为默认值时生效（用户改过的值不动）。
watch(
  () => form.reasoning,
  (reasoning) => {
    if (isEdit.value) return
    if (reasoning && form.maxTokens <= DEFAULT_MAX_TOKENS) form.maxTokens = REASONING_MAX_TOKENS
  }
)

function close(): void {
  emit('update:show', false)
}

/** 表单定价 → 存储形态（未启用自定义定价时返回 null）。 */
function buildPricing(): ModelPricing | null {
  if (!form.pricingEnabled) return null
  return {
    input: form.inputPrice,
    output: form.outputPrice,
    cacheRead: form.cacheReadPrice,
    cacheWrite: form.cacheWritePrice,
    peakPeriods: form.peakPricing
      ? form.peakPeriods.map((p) => ({
          startMinutes: timeToMinutes(p.start),
          endMinutes: timeToMinutes(p.end),
          multiplier: p.multiplier
        }))
      : []
  }
}

function addPeakPeriod(): void {
  form.peakPeriods.push({
    start: minutesToTime(18 * 60),
    end: minutesToTime(22 * 60),
    multiplier: 2
  })
}

function removePeakPeriod(index: number): void {
  form.peakPeriods.splice(index, 1)
}

/** 能否在线拉取：预置模式下有表单 key，或编辑模式已存 key。 */
const canRefreshOnline = computed(
  () =>
    !!form.presetProvider && (!!form.apiKey.trim() || (isEdit.value && !!props.editing?.hasApiKey))
)

/** 从服务商在线拉取模型：优先用表单 key；编辑模式无新 key 时用已存 key。 */
async function refreshOnline(): Promise<void> {
  if (!form.presetProvider || !canRefreshOnline.value) return
  refreshing.value = true
  try {
    const key = form.apiKey.trim()
    onlineModels.value = key
      ? await store.listPresetModelsOnline(form.presetProvider, key)
      : await store.listPresetModelsOnlineById(props.editing!.id)
    message.success(`拉取到 ${onlineModels.value.length} 个在线模型`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    refreshing.value = false
  }
}

function buildInput(): CreateModelConfigInput {
  return {
    displayName: form.displayName.trim() || form.modelId.trim(),
    source: form.mode,
    presetProvider: form.mode === 'preset' ? form.presetProvider : null,
    apiFormat: effectiveApiFormat.value,
    baseUrl: form.mode === 'custom' ? form.baseUrl.trim() : null,
    modelId: form.modelId.trim(),
    contextWindow: form.contextWindow,
    maxTokens: form.maxTokens,
    multimodal: form.multimodal,
    reasoning: form.reasoning,
    pricing: buildPricing(),
    apiKey: form.apiKey.trim() || undefined
  }
}

async function onSave(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    if (props.editing) {
      const patch: UpdateModelConfigInput = {
        displayName: form.displayName.trim() || form.modelId.trim(),
        baseUrl: form.mode === 'custom' ? form.baseUrl.trim() : null,
        modelId: form.modelId.trim(),
        contextWindow: form.contextWindow,
        maxTokens: form.maxTokens,
        multimodal: form.multimodal,
        reasoning: form.reasoning,
        pricing: buildPricing(),
        apiKey: form.apiKey.trim() ? form.apiKey.trim() : props.editing.hasApiKey ? undefined : null
      }
      await store.update(props.editing.id, patch)
      message.success('模型已更新')
    } else {
      await store.create(buildInput(), form.apiKey.trim() || undefined)
      message.success('模型已添加')
    }
    close()
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    saving.value = false
  }
}

async function onTest(): Promise<void> {
  if (!props.editing) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await store.test(props.editing.id)
  } catch (err) {
    testResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    testing.value = false
  }
}

async function openGetKey(): Promise<void> {
  const url = currentPreset.value?.getKeyUrl
  if (url) await mainClient.app.openExternal(url)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="dialogTitle"
    :style="{ width: '520px', maxWidth: 'calc(100vw - 48px)' }"
    :mask-closable="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <!-- 模式切换：编辑模式下锁定 -->
    <NRadioGroup v-model:value="form.mode" :disabled="isEdit" class="add-model__mode">
      <NRadioButton value="preset">模型服务商</NRadioButton>
      <NRadioButton value="custom">自定义配置</NRadioButton>
    </NRadioGroup>

    <!-- 预置服务商模式 -->
    <template v-if="form.mode === 'preset'">
      <div class="add-model__field">
        <label class="add-model__label">服务商</label>
        <NSelect
          v-model:value="form.presetProvider"
          :options="providerOptions"
          filterable
          :disabled="isEdit"
          placeholder="选择服务商"
        />
      </div>

      <!-- API 密钥（置于服务商下方：填写后自动拉取模型列表） -->
      <div class="add-model__field">
        <label class="add-model__label">API 密钥</label>
        <NInput
          v-model:value="form.apiKey"
          type="password"
          show-password-on="click"
          :placeholder="isEdit ? '已配置（重新输入覆盖，留空不变）' : 'sk-...'"
          autocomplete="off"
          spellcheck="false"
        />
        <NButton
          v-if="currentPreset?.getKeyUrl"
          text
          type="primary"
          size="small"
          @click="openGetKey"
        >
          前往 {{ currentPreset?.name }} 获取 API Key →
        </NButton>
      </div>

      <div class="add-model__field">
        <div class="add-model__field-head">
          <label class="add-model__label">模型</label>
          <NRadioGroup v-model:value="form.modelSelectMode" size="small">
            <NRadioButton value="catalog">从列表选择</NRadioButton>
            <NRadioButton value="custom">手动输入</NRadioButton>
          </NRadioGroup>
        </div>
        <NSelect
          v-if="form.modelSelectMode === 'catalog'"
          v-model:value="form.modelId"
          :options="catalogOptions"
          filterable
          :disabled="!form.presetProvider"
          placeholder="选择模型"
        />
        <div v-if="form.modelSelectMode === 'catalog'" class="add-model__refresh">
          <NButton
            size="tiny"
            tertiary
            :loading="refreshing"
            :disabled="!canRefreshOnline"
            @click="refreshOnline"
          >
            从服务商在线拉取模型
          </NButton>
          <span class="add-model__hint"
            >模型列表始终从服务商在线拉取；填写 API
            密钥后自动获取，编辑已有模型时使用已保存的密钥。</span
          >
        </div>
        <NInput
          v-else
          v-model:value="form.modelId"
          placeholder="填写模型 ID，如 gpt-4o-mini"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </template>

    <!-- 自定义配置模式 -->
    <template v-else>
      <div class="add-model__field">
        <label class="add-model__label">API 格式</label>
        <NSelect v-model:value="form.apiFormat" :options="apiFormatOptions" :disabled="isEdit" />
      </div>

      <div class="add-model__field">
        <label class="add-model__label">请求地址（Base URL）</label>
        <NInput
          v-model:value="form.baseUrl"
          placeholder="https://api.example.com/v1"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="add-model__hint">填基础地址，不含 /chat/completions 路径。</span>
      </div>

      <div class="add-model__field">
        <label class="add-model__label">模型 ID</label>
        <NInput
          v-model:value="form.modelId"
          placeholder="如 gpt-4o-mini、llama3.2"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <!-- API 密钥 -->
      <div class="add-model__field">
        <label class="add-model__label">API 密钥</label>
        <NInput
          v-model:value="form.apiKey"
          type="password"
          show-password-on="click"
          :placeholder="isEdit ? '已配置（重新输入覆盖，留空不变）' : 'sk-...'"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    </template>

    <!-- 高级配置 -->
    <NCollapse class="add-model__advanced">
      <NCollapseItem title="高级配置" name="advanced">
        <div class="add-model__field">
          <label class="add-model__label">展示名称（选填）</label>
          <NInput
            v-model:value="form.displayName"
            :placeholder="form.modelId || '默认显示模型 ID'"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <div class="add-model__row">
          <div class="add-model__field add-model__field--half">
            <label class="add-model__label">上下文窗口</label>
            <NInputNumber v-model:value="form.contextWindow" :min="1024" :step="1024" />
          </div>
          <div class="add-model__field add-model__field--half">
            <label class="add-model__label">最大输出 Tokens</label>
            <NInputNumber v-model:value="form.maxTokens" :min="1" :step="256" />
          </div>
        </div>
        <div class="add-model__row">
          <div class="add-model__field add-model__field--half">
            <label class="add-model__label">多模态（图片输入）</label>
            <NSwitch v-model:value="form.multimodal" />
          </div>
          <div class="add-model__field add-model__field--half">
            <label class="add-model__label">推理（reasoning）</label>
            <NSwitch v-model:value="form.reasoning" />
          </div>
        </div>

        <!-- 定价 -->
        <div class="add-model__field">
          <div class="add-model__field-head">
            <label class="add-model__label">自定义定价（¥/M tokens）</label>
            <NSwitch v-model:value="form.pricingEnabled" />
          </div>
          <span class="add-model__hint">
            关闭时预置模型使用服务商内置价、自定义模型计 0；开启后按下方单价计算用量成本。DeepSeek
            预填官方人民币价。
          </span>
        </div>
        <template v-if="form.pricingEnabled">
          <div class="add-model__row">
            <div class="add-model__field add-model__field--half">
              <label class="add-model__label">输入价</label>
              <NInputNumber
                v-model:value="form.inputPrice"
                :min="0"
                :step="0.01"
                :precision="4"
                size="small"
              />
            </div>
            <div class="add-model__field add-model__field--half">
              <label class="add-model__label">输出价</label>
              <NInputNumber
                v-model:value="form.outputPrice"
                :min="0"
                :step="0.01"
                :precision="4"
                size="small"
              />
            </div>
          </div>
          <div class="add-model__row">
            <div class="add-model__field add-model__field--half">
              <label class="add-model__label">缓存命中价</label>
              <NInputNumber
                v-model:value="form.cacheReadPrice"
                :min="0"
                :step="0.001"
                :precision="6"
                size="small"
              />
            </div>
            <div class="add-model__field add-model__field--half">
              <label class="add-model__label">缓存写入价</label>
              <NInputNumber
                v-model:value="form.cacheWritePrice"
                :min="0"
                :step="0.001"
                :precision="6"
                size="small"
              />
            </div>
          </div>

          <div class="add-model__field">
            <div class="add-model__field-head">
              <label class="add-model__label">分时段定价（高峰倍率）</label>
              <NSwitch v-model:value="form.peakPricing" />
            </div>
            <span class="add-model__hint">
              命中高峰时段时按「基准价 × 倍率」计费。DeepSeek
              白天高峰翻倍（09:00-12:00、14:00-18:00）。
            </span>
          </div>
          <template v-if="form.peakPricing">
            <div v-for="(p, i) in form.peakPeriods" :key="i" class="add-model__period">
              <NTimePicker v-model:value="p.start" format="HH:mm" size="small" />
              <span class="add-model__period-sep">—</span>
              <NTimePicker v-model:value="p.end" format="HH:mm" size="small" />
              <NInputNumber
                v-model:value="p.multiplier"
                :min="1"
                :step="0.5"
                size="small"
                style="width: 80px"
              />
              <span class="add-model__period-sep">倍</span>
              <NButton size="tiny" quaternary type="error" @click="removePeakPeriod(i)">
                删除
              </NButton>
            </div>
            <NButton size="tiny" dashed @click="addPeakPeriod">+ 添加高峰时段</NButton>
          </template>
        </template>
      </NCollapseItem>
    </NCollapse>

    <!-- 测试结果 -->
    <NAlert
      v-if="testResult"
      :type="testResult.ok ? 'success' : 'error'"
      :show-icon="true"
      class="add-model__alert"
    >
      {{ testResult.ok ? '连接成功' : `连接失败：${testResult.error ?? '未知错误'}` }}
    </NAlert>

    <template #footer>
      <NSpace justify="space-between" align="center">
        <NButton :loading="testing" :disabled="!isEdit" @click="onTest"> 测试连接 </NButton>
        <NSpace>
          <NButton @click="close">取消</NButton>
          <NButton type="primary" :loading="saving" :disabled="!canSave" @click="onSave">
            保存
          </NButton>
        </NSpace>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.add-model__mode {
  margin-bottom: 16px;
}
.add-model__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}
.add-model__field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.add-model__field--half {
  flex: 1;
  margin-bottom: 0;
}
.add-model__label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.add-model__hint {
  font-size: 11px;
  color: var(--text-3);
}
.add-model__row {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
}
.add-model__advanced {
  margin-bottom: 12px;
}
.add-model__refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.add-model__period {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.add-model__period-sep {
  font-size: 12px;
  color: var(--text-3);
}
.add-model__alert {
  margin-top: 4px;
}
</style>
