<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NButton, NCard, NProgress, NSwitch, NTag } from 'naive-ui'
import { useUpdateStore } from '@renderer/store/useUpdateStore'

const update = useUpdateStore()

/** 状态机阶段 → 中文文案（设置页展示）。 */
const phaseLabel = computed(() => {
  switch (update.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return update.availableVersion ? `发现新版本 v${update.availableVersion}` : '发现新版本'
    case 'downloading':
      return `下载中 ${update.percent ?? 0}%`
    case 'downloaded':
      return `更新已下载（v${update.availableVersion ?? ''}），重启后生效`
    case 'upToDate':
      return '已是最新版本'
    case 'error':
      return '检查更新失败'
    default:
      return '尚未检查更新'
  }
})

function onCheck(): void {
  void update.checkNow()
}

function onDownload(): void {
  void update.download()
}

function onInstall(): void {
  update.install()
}

async function onAutoCheckChange(enabled: boolean): Promise<void> {
  await update.setAutoCheckEnabled(enabled)
}

onMounted(() => {
  // 主动拉一次快照：状态推送可能早于本面板挂载（如启动自动检查已完成）
  void update.refresh()
})
</script>

<template>
  <div>
    <NCard size="small" class="settings-card">
      <template #header>
        <span>软件更新</span>
      </template>
      <div class="data-row">
        <div class="data-row__info">
          <span class="data-row__label">启动时自动检查</span>
          <span class="data-row__hint">每次启动应用后自动检查 GitHub Releases 是否有新版本</span>
        </div>
        <NSwitch
          :value="update.autoCheckEnabled"
          :disabled="!update.supported"
          @update:value="onAutoCheckChange"
        />
      </div>

      <div class="update-status">
        <div class="update-status__line">
          <span class="update-status__version">当前版本 v{{ update.currentVersion }}</span>
          <NTag v-if="!update.supported" size="small" type="warning" :bordered="false">
            安装版支持自动更新
          </NTag>
          <span
            v-else-if="update.phase !== 'idle'"
            class="update-status__state"
            :class="{ 'update-status__state--error': update.phase === 'error' }"
          >
            {{ phaseLabel }}
          </span>
        </div>

        <div v-if="update.phase === 'downloading'" class="update-progress">
          <NProgress type="line" :percentage="update.percent ?? 0" :show-text="false" />
        </div>

        <div class="update-actions">
          <NButton
            size="small"
            secondary
            :loading="update.phase === 'checking'"
            :disabled="!update.supported || update.isBusy"
            @click="onCheck"
          >
            {{ update.phase === 'error' ? '重试检查' : '检查更新' }}
          </NButton>
          <NButton
            v-if="update.phase === 'available'"
            size="small"
            type="primary"
            @click="onDownload"
          >
            下载更新
          </NButton>
          <NButton
            v-if="update.phase === 'downloaded'"
            size="small"
            type="primary"
            @click="onInstall"
          >
            立即重启安装
          </NButton>
        </div>

        <p v-if="update.error" class="update-error">{{ update.error }}</p>

        <div v-if="update.releaseNotes" class="update-notes">
          <div class="update-notes__title">更新说明</div>
          <pre class="update-notes__body">{{ update.releaseNotes }}</pre>
        </div>
      </div>
    </NCard>

    <NCard size="small" class="settings-card">
      <template #header>
        <span>关于</span>
      </template>
      <div class="about">
        <div class="about__head">
          <div class="about__icon">AI</div>
          <div>
            <h2 class="about__title">桌面助手</h2>
            <p class="about__subtitle">
              本地优先的 AI 对话助手
              <span v-if="update.currentVersion" class="about__version"
                >v{{ update.currentVersion }}</span
              >
            </p>
          </div>
        </div>

        <section class="about__section">
          <h3 class="about__heading">简介</h3>
          <p class="about__text">
            基于 <code>Electron</code> + <code>Vue 3</code> + <code>TypeScript</code> 构建的桌面端
            AI 对话助手。支持多家模型服务商与自定义 OpenAI/Anthropic 兼容端点，API Key
            经系统安全存储加密，不会离开你的设备。
          </p>
          <p class="about__text">
            内置文件读写、命令执行、网页搜索、技能市场、MCP
            扩展等工具能力，并支持会话压缩、长期记忆与用量统计。
          </p>
        </section>

        <section class="about__section">
          <h3 class="about__heading">技术栈</h3>
          <ul class="about__list">
            <li><code>Electron</code> + <code>electron-vite</code> 跨平台桌面壳</li>
            <li><code>Vue 3</code> + <code>Pinia</code> + <code>Vue Router</code> 前端框架</li>
            <li><code>Naive UI</code> 组件库，深浅双主题</li>
            <li>
              <code>@earendil-works/pi-ai</code> + <code>pi-agent-core</code> 模型与 Agent 能力
            </li>
            <li><code>node:sqlite</code> 本地数据库 + MCP 协议支持</li>
          </ul>
        </section>

        <section class="about__section">
          <h3 class="about__heading">关键能力</h3>
          <div class="about__tags">
            <NTag size="small" :bordered="false">多模型管理</NTag>
            <NTag size="small" :bordered="false">流式渲染</NTag>
            <NTag size="small" :bordered="false">工具调用</NTag>
            <NTag size="small" :bordered="false">MCP 扩展</NTag>
            <NTag size="small" :bordered="false">技能市场</NTag>
            <NTag size="small" :bordered="false">长期记忆</NTag>
            <NTag size="small" :bordered="false">会话压缩</NTag>
            <NTag size="small" :bordered="false">用量统计</NTag>
          </div>
        </section>
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

/* 更新 */
.data-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin: 0 -8px;
  padding: 0 8px 12px;
}
.data-row--gap {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.data-row__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.data-row__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-1);
}
.data-row__hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}

.update-status {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.update-status__line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.update-status__version {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.update-status__state {
  font-size: 12px;
  color: var(--text-2);
}
.update-status__state--error {
  color: var(--error, #d03050);
}
.update-progress {
  margin-top: 8px;
}
.update-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.update-error {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--error, #d03050);
}
.update-notes {
  margin-top: 12px;
}
.update-notes__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.update-notes__body {
  margin: 6px 0 0;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  font-family: inherit;
}

/* 关于 */
.about {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.about__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.about__icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}
.about__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-1);
}
.about__subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.about__version {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-mute);
  font-size: 11px;
  color: var(--text-2);
}
.about__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.about__heading {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.about__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}
.about__list {
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.about__list li {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}
.about__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.about code {
  background: var(--bg-mute);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-1);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
}
</style>
