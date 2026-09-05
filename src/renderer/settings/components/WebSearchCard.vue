<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  NCard,
  NTag,
  NInput,
  NSpace,
  NButton,
  NPopconfirm,
  NAlert,
  NSwitch,
  useMessage
} from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { mainClient } from '@renderer/utils/main-client'

/** web_search 工具在工具注册表中的 name。 */
const WEB_SEARCH_TOOL = 'web_search'

const settings = useSettingsStore()
const message = useMessage()

/** 网页搜索工具当前启用状态。 */
const enabled = computed(
  () => settings.tools.find((t) => t.name === WEB_SEARCH_TOOL)?.enabled ?? false
)

async function onToggle(value: boolean): Promise<void> {
  await settings.saveToolEnabled(WEB_SEARCH_TOOL, value)
  message.success(`${value ? '已启用' : '已关闭'}：网页搜索`)
}

// ---- API Key 配置 ----
const webSearchKey = ref('')
const webSearchSaving = ref(false)
const webSearchTesting = ref(false)
const webSearchTestResult = ref<{ ok: boolean; error?: string } | null>(null)

async function onSave(): Promise<void> {
  const key = webSearchKey.value.trim()
  if (!key) {
    message.warning('请输入 Tavily API Key')
    return
  }
  webSearchSaving.value = true
  try {
    await settings.saveWebSearchApiKey(key)
    webSearchKey.value = ''
    webSearchTestResult.value = null
    message.success('Tavily API Key 已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    webSearchSaving.value = false
  }
}

async function onClear(): Promise<void> {
  await settings.clearWebSearchApiKey()
  webSearchKey.value = ''
  webSearchTestResult.value = null
  message.success('Tavily API Key 已清除')
}

/** 测试连接：输入框有值用输入值，否则用已保存的 key。 */
async function onTest(): Promise<void> {
  webSearchTesting.value = true
  webSearchTestResult.value = null
  try {
    webSearchTestResult.value = await settings.testWebSearch(webSearchKey.value.trim() || undefined)
  } catch (err) {
    webSearchTestResult.value = {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    webSearchTesting.value = false
  }
}

function openKeyPage(): void {
  void mainClient.app.openExternal('https://app.tavily.com/')
}
</script>

<template>
  <NCard size="small" class="settings-card">
    <template #header>
      <span>网页搜索（Tavily）</span>
    </template>
    <template #header-extra>
      <NTag :type="settings.webSearchKeyConfigured ? 'success' : 'warning'" size="small" round>
        {{ settings.webSearchKeyConfigured ? '已配置 Key' : '未配置 Key' }}
      </NTag>
    </template>

    <!-- 启用开关 -->
    <div class="tool-toggle">
      <div class="tool-toggle__info">
        <span class="tool-toggle__name">启用网页搜索</span>
        <span class="tool-toggle__desc">
          开启后 Agent 可调用 Tavily 搜索网页。关闭后工具不再注入，下一轮生效。
        </span>
      </div>
      <NSwitch :value="enabled" @update:value="onToggle" />
    </div>

    <!-- API Key 配置 -->
    <p class="config-desc">
      网页搜索工具使用 Tavily Web Search API，启用前需要先配置 API Key。Key
      通过系统安全存储加密保存，不会离开本机。
    </p>
    <div class="websearch-row">
      <NInput
        v-model:value="webSearchKey"
        type="password"
        show-password-on="click"
        placeholder="tvly-..."
        autocomplete="off"
        spellcheck="false"
        class="websearch-row__input"
      />
      <NSpace :size="8" align="center">
        <NButton :loading="webSearchTesting" @click="onTest">测试连接</NButton>
        <NButton type="primary" :loading="webSearchSaving" @click="onSave">保存</NButton>
        <NPopconfirm
          v-if="settings.webSearchKeyConfigured"
          :disabled="webSearchKey.trim().length > 0"
          @positive-click="onClear"
        >
          <template #trigger>
            <NButton tertiary type="error">清除</NButton>
          </template>
          清除后网页搜索将无法使用，确定吗？
        </NPopconfirm>
      </NSpace>
    </div>
    <div class="websearch-footer">
      <span class="websearch-footer__text">还没有 Key？</span>
      <NButton text type="primary" size="small" @click="openKeyPage">
        前往 Tavily 官网获取 →
      </NButton>
    </div>
    <NAlert
      v-if="webSearchTestResult"
      :type="webSearchTestResult.ok ? 'success' : 'error'"
      :show-icon="true"
      class="websearch-alert"
    >
      {{
        webSearchTestResult.ok ? '连接成功' : `连接失败：${webSearchTestResult.error ?? '未知错误'}`
      }}
    </NAlert>
  </NCard>
</template>

<style scoped>
/* 开关 + 配置合并区块 */
.tool-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  margin-bottom: 12px;
}
.tool-toggle__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.tool-toggle__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.tool-toggle__desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
.config-desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}
.websearch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.websearch-row__input {
  flex: 1;
  min-width: 0;
}
.websearch-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.websearch-footer__text {
  font-size: 12px;
  color: var(--text-3);
}
.websearch-alert {
  margin-top: 12px;
}
</style>
