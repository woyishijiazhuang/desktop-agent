<script setup lang="ts">
import { ref } from 'vue'
import {
  NCard,
  NButton,
  NSwitch,
  NInput,
  NSelect,
  NInputNumber,
  NSpace,
  useMessage
} from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import {
  VOICE_PRESETS,
  type VoiceRegion,
  type VoiceLanguage
} from '@main/agent/types'

const settings = useSettingsStore()
const message = useMessage()

// ---- API Key ----
const keyDraft = ref('')
const savingKey = ref(false)
const testing = ref(false)

async function onSaveKey(): Promise<void> {
  const key = keyDraft.value.trim()
  if (!key) {
    message.warning('请输入 API key')
    return
  }
  savingKey.value = true
  try {
    await settings.saveVoiceApiKey(key)
    keyDraft.value = ''
    message.success('API key 已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    savingKey.value = false
  }
}

async function onClearKey(): Promise<void> {
  await settings.clearVoiceApiKey()
  message.success('已清除 API key')
}

async function onTest(): Promise<void> {
  if (!settings.voiceHasApiKey) {
    message.warning('请先保存 API key')
    return
  }
  testing.value = true
  try {
    const r = await settings.testVoice()
    if (r.ok) message.success('语音服务连接正常（短文本合成测试通过）')
    else message.error(`连接失败：${r.error}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    testing.value = false
  }
}

// ---- 常规设置 ----
async function onRegionChange(v: VoiceRegion): Promise<void> {
  await settings.saveVoiceRegion(v)
  message.success(v === 'cn' ? '已切换为 Token Plan 中国大陆接入' : '已切换为全球 API 接入')
}

async function onLanguageChange(v: VoiceLanguage): Promise<void> {
  await settings.saveVoiceLanguage(v)
  message.success('识别语言已更新')
}

async function onVoiceChange(id: string): Promise<void> {
  await settings.saveVoiceTtsVoice(id)
  message.success('朗读音色已更新')
}

/** 风格指令草稿（失焦提交，避免每次击键落库）。 */
const styleDraft = ref(settings.voiceTtsStyle)
async function onStyleBlur(): Promise<void> {
  const v = styleDraft.value.trim()
  if (v === settings.voiceTtsStyle) return
  await settings.saveVoiceTtsStyle(v)
  message.success(v ? '朗读风格已更新' : '已清除朗读风格')
}

/** 断句静音时长草稿（秒）。 */
const silenceDraft = ref<number | null>(settings.voiceSilenceSec)
async function onSilenceBlur(): Promise<void> {
  const v = Number(silenceDraft.value)
  if (!Number.isFinite(v) || v < 0.1 || v > 5) {
    silenceDraft.value = settings.voiceSilenceSec
    return
  }
  if (v === settings.voiceSilenceSec) return
  await settings.saveVoiceSilenceSec(v)
  message.success(`静音断句阈值已设为 ${v.toFixed(1)} 秒`)
}

async function onFastChannelChange(v: boolean): Promise<void> {
  await settings.saveVoiceFastChannel(v)
  message.success(v ? '已开启语音快通道（回复更快、更口语化）' : '已关闭语音快通道（保留工具与思考）')
}

const regionOptions = [
  { label: '中国大陆（Token Plan）', value: 'cn' },
  { label: '全球（Global API）', value: 'global' }
]
const languageOptions = [
  { label: '自动识别', value: 'auto' },
  { label: '中文', value: 'zh' },
  { label: '英文', value: 'en' }
]
const voiceOptions = VOICE_PRESETS.map((v) => ({ label: v.name, value: v.id }))
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>语音对话</span>
      </template>
      <p class="settings-card__desc">
        语音对话使用小米 MiMo 语音 API（ASR + TTS，当前限时免费）。在聊天框点击麦克风按钮即可开启
        「点击一次持续对话」：说话自动断句发送，AI 回复口语化精简并自动朗读，朗读时开口即可打断。
        API key 请在
        <a href="https://platform.xiaomimimo.com" target="_blank" rel="noreferrer">platform.xiaomimimo.com</a>
        申请。
      </p>

      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">MiMo API Key</span>
          <span class="data-row__hint">
            {{
              settings.voiceHasApiKey
                ? '已配置（加密存储，明文不落盘）'
                : '未配置——语音对话不可用'
            }}
          </span>
        </div>
        <NSpace align="center" :size="8">
          <NInput
            v-model:value="keyDraft"
            type="password"
            show-password-on="click"
            placeholder="输入 MiMo API key"
            style="width: 260px"
            :disabled="savingKey || settings.voiceHasApiKey"
            @keydown.enter="onSaveKey"
          />
          <NButton
            v-if="!settings.voiceHasApiKey"
            size="small"
            type="primary"
            :loading="savingKey"
            @click="onSaveKey"
          >
            保存
          </NButton>
          <template v-else>
            <NButton size="small" quaternary :loading="testing" @click="onTest">测试</NButton>
            <NButton size="small" quaternary @click="onClearKey">清除</NButton>
          </template>
        </NSpace>
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">接入区域</span>
          <span class="data-row__hint">中国大陆走 Token Plan 节点；海外/网络原因可切换全球节点</span>
        </div>
        <NSelect
          :value="settings.voiceRegion"
          :options="regionOptions"
          size="small"
          style="width: 200px"
          @update:value="onRegionChange"
        />
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">识别语言</span>
          <span class="data-row__hint">指定语言可提升识别准确率；中英混说建议「自动识别」</span>
        </div>
        <NSelect
          :value="settings.voiceLanguage"
          :options="languageOptions"
          size="small"
          style="width: 140px"
          @update:value="onLanguageChange"
        />
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">朗读音色</span>
          <span class="data-row__hint">AI 回复的朗读声线</span>
        </div>
        <NSelect
          :value="settings.voiceTtsVoice"
          :options="voiceOptions"
          size="small"
          style="width: 180px"
          @update:value="onVoiceChange"
        />
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">朗读风格</span>
          <span class="data-row__hint">自然语言描述，如「温柔、口语化、语速适中」；留空用默认</span>
        </div>
        <NInput
          v-model:value="styleDraft"
          placeholder="如：温柔、口语化"
          style="width: 240px"
          @blur="onStyleBlur"
        />
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">断句静音时长</span>
          <span class="data-row__hint">说完一句话后停顿多久视为说完。越短响应越快，环境噪声大时建议调大</span>
        </div>
        <NInputNumber
          v-model:value="silenceDraft"
          :min="0.1"
          :max="5"
          :step="0.1"
          :precision="1"
          style="width: 120px"
          @blur="onSilenceBlur"
        >
          <template #suffix>秒</template>
        </NInputNumber>
      </div>

      <div class="data-row data-row--gap">
        <div class="data-row__info">
          <span class="data-row__label">语音快通道</span>
          <span class="data-row__hint">
            语音对话时关闭思考，回复更快、更适合朗读；需要实时/外部信息（天气、文件、命令）时仍会正常调用工具，关闭则保留完整 Agent 能力（工具+思考）
          </span>
        </div>
        <NSwitch :value="settings.voiceFastChannel" @update:value="onFastChannelChange" />
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.settings-card {
  margin-bottom: 16px;
}
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.settings-card__desc a {
  color: var(--primary);
}

.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.data-row--gap {
  margin-top: 8px;
}
.data-row__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  margin-right: 12px;
}
.data-row__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.data-row__hint {
  font-size: 12px;
  color: var(--text-3);
}
</style>
