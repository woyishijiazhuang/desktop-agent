<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  NCard,
  NSwitch,
  NButton,
  NTag,
  NPopconfirm,
  NSpace,
  NScrollbar,
  NRadioGroup,
  NRadioButton,
  NIcon,
  NInputNumber,
  useMessage
} from 'naive-ui'
import {
  OptionsOutline,
  CubeOutline,
  BuildOutline,
  ExtensionPuzzleOutline,
  GitNetworkOutline,
  FolderOpenOutline,
  StatsChartOutline,
  BookOutline,
  LibraryOutline,
  LayersOutline,
  InformationCircleOutline
} from '@vicons/ionicons5'
import SystemPromptEditor from '@renderer/components/settings/SystemPromptEditor.vue'
import AddModelDialog from '@renderer/components/settings/AddModelDialog.vue'
import UsagePanel from '@renderer/components/settings/UsagePanel.vue'
import ToolsPanel from '@renderer/components/settings/ToolsPanel.vue'
import SkillsPanel from '@renderer/components/settings/SkillsPanel.vue'
import McpPanel from '@renderer/components/settings/McpPanel.vue'
import MemoryPanel from '@renderer/components/settings/MemoryPanel.vue'
import KnowledgePanel from '@renderer/components/settings/KnowledgePanel.vue'
import WorkspacePanel from '@renderer/components/settings/WorkspacePanel.vue'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useModelConfigsStore } from '@renderer/store/useModelConfigsStore'
import { useThemeStore, type ThemeMode } from '@renderer/store/useThemeStore'
import { useWindowStore } from '@renderer/store/useWindowStore'
import { mainClient } from '@renderer/utils/main-client'
import { SETTINGS_TAB_EVENT } from '@renderer/service/ui-service'
import { formatContextWindow } from '@renderer/utils/format'
import type { ModelConfigSummary, TitleBarMode } from '@main/agent/types'

const settings = useSettingsStore()
const modelConfigs = useModelConfigsStore()
const theme = useThemeStore()
const windowStore = useWindowStore()
const message = useMessage()

/** 当前激活的分类。 */
const activeTab = ref('general')

/** 左侧导航分类。 */
const navItems = [
  { key: 'general', label: '通用', icon: OptionsOutline },
  { key: 'workspace', label: '工作区', icon: LayersOutline },
  { key: 'models', label: '模型', icon: CubeOutline },
  { key: 'usage', label: '用量', icon: StatsChartOutline },
  { key: 'tools', label: '工具', icon: BuildOutline },
  { key: 'skills', label: '技能', icon: ExtensionPuzzleOutline },
  { key: 'memory', label: '记忆', icon: BookOutline },
  { key: 'knowledge', label: '知识库', icon: LibraryOutline },
  { key: 'mcp', label: 'MCP', icon: GitNetworkOutline },
  { key: 'data', label: '数据与诊断', icon: FolderOpenOutline },
  { key: 'about', label: '关于', icon: InformationCircleOutline }
]

/** 系统提示保存中（独立于 API key 的 saving）。 */
const promptSaving = ref(false)

/** AddModelDialog 显示状态与编辑目标。 */
const dialogShow = ref(false)
const editing = ref<ModelConfigSummary | null>(null)

// ---- 通用（桌面能力） ----
/** 开机自启状态（登录项由系统持久化）。 */
const autoLaunch = ref(false)
/** 应用版本。 */
const appVersion = ref('')

async function onAutoLaunchChange(value: boolean): Promise<void> {
  try {
    await mainClient.app.setAutoLaunch(value)
    autoLaunch.value = value
    message.success(value ? '已开启开机自启' : '已关闭开机自启')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function onCloseToTrayChange(value: boolean): Promise<void> {
  await settings.saveCloseToTray(value)
  message.success(value ? '已开启：关闭窗口时最小化到托盘' : '已关闭：关闭窗口时按默认行为退出')
}

/** 窗口置顶开关（状态实时取自 windowStore）。 */
async function onAlwaysOnTopChange(value: boolean): Promise<void> {
  await mainClient.window.triggerWindowAction(value ? 'always-on-top' : 'cancel-always-on-top')
  message.success(value ? '已置顶窗口' : '已取消置顶')
}

async function onNotificationsChange(value: boolean): Promise<void> {
  await settings.saveNotificationsEnabled(value)
  message.success(value ? '已开启桌面通知' : '已关闭桌面通知')
}

// ---- 工具确认 ----
/** 切换「跳过工具确认」：main 侧实时读取，下一次工具调用立即生效。 */
async function onPermissionAutoApproveChange(value: boolean): Promise<void> {
  await settings.savePermissionAutoApprove(value)
  message.success(
    value ? '已开启：危险工具免确认执行（破坏性命令除外）' : '已关闭：危险工具恢复逐次确认'
  )
}

/** 确认超时草稿（秒，0 = 一直等待）：失焦时才提交保存。 */
const permTimeoutDraft = ref<number | null>(settings.permissionTimeoutSec)

watch(
  () => settings.permissionTimeoutSec,
  (v) => {
    permTimeoutDraft.value = v
  }
)

async function onPermTimeoutBlur(): Promise<void> {
  const v = Math.floor(Number(permTimeoutDraft.value) || 0)
  // 非法值（空/负数）：还原为已保存值
  if (!Number.isInteger(v) || v < 0) {
    permTimeoutDraft.value = settings.permissionTimeoutSec
    return
  }
  if (v === settings.permissionTimeoutSec) return
  await settings.savePermissionTimeoutSec(v)
  message.success(v === 0 ? '已设为一直等待，不自动拒绝' : `确认超时已设为 ${v} 秒`)
}

const testingNotification = ref(false)
async function onTestNotification(): Promise<void> {
  testingNotification.value = true
  try {
    const result = await mainClient.agent.testNotification()
    if (result.success) {
      message.success('测试通知已发送，请查看桌面右上角')
    } else {
      message.warning(`通知发送失败：${result.error}`)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    testingNotification.value = false
  }
}

/** 切换标题栏模式：main 侧持久化并重建窗口。 */
async function onTitleBarModeChange(mode: TitleBarMode): Promise<void> {
  if (mode === settings.titleBarMode) return
  await settings.saveTitleBarMode(mode)
  message.success(mode === 'native' ? '已切换为原生标题栏' : '已切换为自定义标题栏')
}

// ---- 诊断与日志 ----
/** 日志 / 崩溃目录路径（展示与打开用）。 */
const diagInfo = ref<{ logDir: string; crashDumpsDir: string } | null>(null)

async function openDiagDir(which: 'logs' | 'crashes'): Promise<void> {
  try {
    await mainClient.app.openDiagnosticsDir(which)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

/** 清空日志文件内容（保留文件，日志继续写入）。 */
async function onClearLogs(): Promise<void> {
  await mainClient.app.clearLogs()
  message.success('日志已清空')
}

// ---- 数据管理（回收站） ----
/** 回收站中的会话数量。 */
const trashCount = ref(0)

async function loadTrashCount(): Promise<void> {
  trashCount.value = await mainClient.db.countTrashSessions()
}

/** 手动清空回收站（物理删除全部软删除会话）。 */
async function onPurgeTrash(): Promise<void> {
  await mainClient.db.purgeTrash()
  trashCount.value = 0
  message.success('回收站已清空')
}

onMounted(async () => {
  await Promise.all([
    settings.loadSettings(),
    modelConfigs.load(),
    loadTrashCount(),
    mainClient.app.getAutoLaunch().then((v) => (autoLaunch.value = v)),
    mainClient.app.getDiagnosticsInfo().then((info) => (diagInfo.value = info)),
    mainClient.app.getAppVersion().then((v) => (appVersion.value = v))
  ])
  // 跨窗口 tab 导航（工作区窗口「管理工作区」入口经 ui.settingsTab 推送）
  window.addEventListener(SETTINGS_TAB_EVENT, onSettingsTabEvent)
})

onUnmounted(() => {
  window.removeEventListener(SETTINGS_TAB_EVENT, onSettingsTabEvent)
})

/** 处理跨窗口 tab 导航：切到合法 tab，非法值忽略。 */
function onSettingsTabEvent(e: Event): void {
  const tab = (e as CustomEvent<string>).detail
  if (navItems.some((i) => i.key === tab)) {
    activeTab.value = tab
  }
}

// ---- 模型配置 ----
function onAdd(): void {
  editing.value = null
  dialogShow.value = true
}

function onEdit(config: ModelConfigSummary): void {
  editing.value = config
  dialogShow.value = true
}

async function onRemove(config: ModelConfigSummary): Promise<void> {
  await modelConfigs.remove(config.id)
  message.success(`已删除：${config.displayName}`)
}

/** 模型来源摘要文案。 */
function sourceLabel(c: ModelConfigSummary): string {
  return c.source === 'preset' ? (c.presetProvider ?? '预置') : '自定义'
}

// ---- 系统提示 ----
async function onPromptSave(value: string): Promise<void> {
  promptSaving.value = true
  try {
    await settings.saveDefaultSystemPrompt(value)
    message.success('系统提示已更新')
  } finally {
    promptSaving.value = false
  }
}

// ---- 最大轮次 ----
/**
 * 输入框本地临时值（v-model），失焦时才提交保存。
 * 避免 NInputNumber 每次值变化（如输入多位数）都触发落库 + 成功提示。
 */
const maxTurnsDraft = ref<number | null>(settings.maxTurnsPerRun)

/** 已保存值变化（loadSettings / 保存成功）时同步草稿，输入过程中不受影响。 */
watch(
  () => settings.maxTurnsPerRun,
  (v) => {
    maxTurnsDraft.value = v
  }
)

async function onMaxTurnsBlur(): Promise<void> {
  const v = Math.floor(Number(maxTurnsDraft.value) || 0)
  // 非法值（空/0/负数）：还原为已保存值
  if (!Number.isInteger(v) || v <= 0) {
    maxTurnsDraft.value = settings.maxTurnsPerRun
    return
  }
  if (v === settings.maxTurnsPerRun) return
  await settings.saveMaxTurnsPerRun(v)
  message.success('最大轮次已更新')
}

// ---- 自动压缩 ----
/** 自动压缩开关（main 侧 prompt 前实时读取，无需驱逐 Agent）。 */
async function onAutoCompressToggle(v: boolean): Promise<void> {
  await settings.saveAutoCompressEnabled(v)
  message.success(v ? '已开启自动压缩' : '已关闭自动压缩')
}

/** 阈值输入框本地临时值（v-model），失焦时才提交保存。 */
const compressThresholdDraft = ref<number | null>(settings.autoCompressThreshold)

/** 已保存值变化（loadSettings / 保存成功）时同步草稿，输入过程中不受影响。 */
watch(
  () => settings.autoCompressThreshold,
  (v) => {
    compressThresholdDraft.value = v
  }
)

async function onThresholdBlur(): Promise<void> {
  const v = Math.round(Number(compressThresholdDraft.value) || 0)
  // 非法值（空/低于下限 50/超界）：还原为已保存值
  if (!Number.isFinite(v) || v < 50 || v > 100) {
    compressThresholdDraft.value = settings.autoCompressThreshold
    return
  }
  if (v === settings.autoCompressThreshold) return
  await settings.saveAutoCompressThreshold(v)
  message.success('压缩阈值已更新')
}

// ---- 外观（主题） ----
function onThemeChange(mode: ThemeMode): void {
  theme.setMode(mode)
}
</script>

<template>
  <div class="settings-view">
    <!-- 左侧分类导航 -->
    <aside class="settings-nav">
      <div class="settings-nav__head">
        <h1 class="settings-nav__title">设置</h1>
      </div>

      <nav class="settings-nav__list">
        <div
          v-for="item in navItems"
          :key="item.key"
          class="settings-nav__item"
          :class="{ 'settings-nav__item--active': activeTab === item.key }"
          :title="item.label"
          @click="activeTab = item.key"
        >
          <NIcon :size="16" class="settings-nav__icon"><component :is="item.icon" /></NIcon>
          <span>{{ item.label }}</span>
        </div>
      </nav>
    </aside>

    <!-- 右侧内容区 -->
    <NScrollbar class="settings-content">
      <!-- ========== 通用 ========== -->
      <div v-show="activeTab === 'general'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>通用</span>
          </template>
          <p class="settings-card__desc">应用外观与桌面行为。</p>
          <div class="data-row">
            <div class="data-row__info">
              <span class="data-row__label">主题</span>
              <span class="data-row__hint">「跟随系统」会随操作系统的深浅色自动切换</span>
            </div>
            <NRadioGroup :value="theme.mode" @update:value="onThemeChange">
              <NRadioButton value="light">浅色</NRadioButton>
              <NRadioButton value="dark">深色</NRadioButton>
              <NRadioButton value="system">跟随系统</NRadioButton>
            </NRadioGroup>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">开机自启</span>
              <span class="data-row__hint">登录系统后自动启动应用</span>
            </div>
            <NSwitch :value="autoLaunch" @update:value="onAutoLaunchChange" />
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">关闭到托盘</span>
              <span class="data-row__hint">
                开启后点击关闭按钮将隐藏到系统托盘而非退出，应用与后台任务保持运行，可从托盘随时唤回
              </span>
            </div>
            <NSwitch :value="settings.closeToTray" @update:value="onCloseToTrayChange" />
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">窗口置顶</span>
              <span class="data-row__hint">始终置顶显示，不被其他窗口遮挡</span>
            </div>
            <NSwitch :value="windowStore.state.isAlwaysOnTop" @update:value="onAlwaysOnTopChange" />
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">桌面通知</span>
              <span class="data-row__hint">任务出错或主动调用通知工具时弹出系统桌面通知</span>
            </div>
            <NSpace align="center" :size="8">
              <NSwitch
                :value="settings.notificationsEnabled"
                @update:value="onNotificationsChange"
              />
              <NButton
                size="small"
                quaternary
                :disabled="!settings.notificationsEnabled || testingNotification"
                :loading="testingNotification"
                @click="onTestNotification"
              >
                测试
              </NButton>
            </NSpace>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">跳过工具确认</span>
              <span class="data-row__hint">
                AI 执行写文件、命令等危险操作时不再逐次确认；破坏性命令（如 rm
                -rf、强制推送）始终需要人工确认
              </span>
            </div>
            <NSwitch
              :value="settings.permissionAutoApprove"
              @update:value="onPermissionAutoApproveChange"
            />
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">工具确认超时</span>
              <span class="data-row__hint">
                等待确认的最长时间，超时未响应将自动拒绝；设为 0 表示一直等待
              </span>
            </div>
            <NInputNumber
              v-model:value="permTimeoutDraft"
              :min="0"
              :max="3600"
              :step="10"
              style="width: 120px"
              @blur="onPermTimeoutBlur"
            >
              <template #suffix>秒</template>
            </NInputNumber>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">标题栏</span>
              <span class="data-row__hint">
                原生模式 macOS 显示系统红绿灯、Windows/Linux
                使用系统标题栏；自定义模式使用应用自绘标题栏
              </span>
            </div>
            <NRadioGroup :value="settings.titleBarMode" @update:value="onTitleBarModeChange">
              <NRadioButton value="custom">自定义</NRadioButton>
              <NRadioButton value="native">原生</NRadioButton>
            </NRadioGroup>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">最大轮次</span>
              <span class="data-row__hint">
                单次对话允许的模型调用轮数上限，达到后自动停止，防止工具死循环消耗 token
              </span>
            </div>
            <NInputNumber
              v-model:value="maxTurnsDraft"
              :min="1"
              :max="1000"
              :step="1"
              style="width: 120px"
              @blur="onMaxTurnsBlur"
            />
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">自动压缩</span>
              <span class="data-row__hint">
                发送消息前若未压缩上下文达到模型窗口的阈值百分比，自动摘要较早的历史，对话变长时无需手动压缩
              </span>
            </div>
            <NSwitch :value="settings.autoCompressEnabled" @update:value="onAutoCompressToggle" />
          </div>
          <div v-if="settings.autoCompressEnabled" class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">压缩阈值</span>
              <span class="data-row__hint">未压缩上下文占模型窗口的百分比，超过则触发自动压缩</span>
            </div>
            <NInputNumber
              v-model:value="compressThresholdDraft"
              :min="50"
              :max="95"
              :step="5"
              style="width: 120px"
              @blur="onThresholdBlur"
            >
              <template #suffix>%</template>
            </NInputNumber>
          </div>
        </NCard>
      </div>

      <!-- ========== 工作区 ========== -->
      <div v-show="activeTab === 'workspace'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>工作区</span>
          </template>
          <p class="settings-card__desc">
            工作区 = 一个项目目录（workdir）+ 专属窗口 + 该目录下的会话与 agent.md
            项目记忆。可同时打开多个工作区窗口，会话按工作区隔离。删除工作区会一并删除其全部会话。
          </p>
          <WorkspacePanel />
        </NCard>
      </div>

      <!-- ========== 模型 ========== -->
      <div v-show="activeTab === 'models'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>模型</span>
          </template>
          <template #header-extra>
            <NTag :type="modelConfigs.hasModel ? 'success' : 'warning'" size="small" round>
              {{ modelConfigs.hasModel ? `${modelConfigs.configs.length} 个` : '未添加' }}
            </NTag>
          </template>
          <p class="settings-card__desc">
            添加和管理模型。支持预置服务商或完全自定义（本地地址 / OpenAI
            兼容端点等）。每个模型独立配置 API Key 与参数，可添加多个、可同一服务商多条。Key
            通过系统安全存储加密保存，不会离开本机。
          </p>

          <!-- 空状态 -->
          <div v-if="modelConfigs.configs.length === 0" class="model-empty">
            <p class="model-empty__text">尚未添加模型，点击下方添加一个即可开始对话。</p>
          </div>

          <!-- 已添加模型列表 -->
          <div v-else class="model-list">
            <div v-for="c in modelConfigs.configs" :key="c.id" class="model-list__item">
              <div class="model-list__head">
                <div class="model-list__info">
                  <span class="model-list__name">{{ c.displayName }}</span>
                  <NTag size="tiny" round>{{ sourceLabel(c) }}</NTag>
                  <NTag v-if="c.multimodal" type="info" size="tiny" round>多模态</NTag>
                  <NTag v-if="c.reasoning" type="info" size="tiny" round>推理</NTag>
                </div>
                <NSpace :size="8" align="center">
                  <NButton size="small" tertiary @click="onEdit(c)">编辑</NButton>
                  <NPopconfirm @positive-click="onRemove(c)">
                    <template #trigger>
                      <NButton size="small" tertiary type="error">删除</NButton>
                    </template>
                    确定要删除「{{ c.displayName }}」吗？此操作不可撤销。
                  </NPopconfirm>
                </NSpace>
              </div>
              <div class="model-list__meta">
                <span>{{ c.modelId }}</span>
                <span>· {{ formatContextWindow(c.contextWindow) }} 上下文</span>
                <span>· {{ formatContextWindow(c.maxTokens) }} 输出</span>
                <NTag :type="c.hasApiKey ? 'success' : 'warning'" size="tiny" round>
                  {{ c.hasApiKey ? '已配置 Key' : '未配置 Key' }}
                </NTag>
              </div>
            </div>
          </div>

          <div class="model-add">
            <NButton type="primary" @click="onAdd">添加模型</NButton>
          </div>
        </NCard>

        <NCard size="small" class="settings-card">
          <template #header>
            <span>默认系统提示</span>
          </template>
          <p class="settings-card__desc">
            定义 Agent 的角色与行为。留空则使用内置默认提示词。修改后对当前会话下一轮生效。
          </p>
          <SystemPromptEditor
            :model-value="settings.defaultSystemPrompt"
            :saving="promptSaving"
            @save="onPromptSave"
          />
        </NCard>
      </div>

      <!-- ========== 用量 ========== -->
      <div v-show="activeTab === 'usage'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>用量统计</span>
          </template>
          <UsagePanel :active="activeTab === 'usage'" />
        </NCard>
      </div>

      <!-- ========== 工具 ========== -->
      <div v-show="activeTab === 'tools'" class="settings-content__inner">
        <ToolsPanel />
      </div>

      <!-- ========== 技能 ========== -->
      <div v-show="activeTab === 'skills'" class="settings-content__inner">
        <SkillsPanel />
      </div>

      <!-- ========== 记忆 ========== -->
      <div v-show="activeTab === 'memory'" class="settings-content__inner">
        <MemoryPanel />
      </div>

      <!-- ========== 知识库 ========== -->
      <div v-show="activeTab === 'knowledge'" class="settings-content__inner">
        <KnowledgePanel />
      </div>

      <!-- ========== MCP ========== -->
      <div v-show="activeTab === 'mcp'" class="settings-content__inner">
        <McpPanel />
      </div>

      <!-- ========== 数据与诊断 ========== -->
      <div v-show="activeTab === 'data'" class="settings-content__inner">
        <NCard size="small" class="settings-card">
          <template #header>
            <span>数据管理</span>
          </template>
          <p class="settings-card__desc">
            删除的会话会移入回收站，保留 30
            天后自动彻底删除。你也可以随时手动清空回收站，被清空的会话及其消息无法恢复。
          </p>
          <div class="data-row">
            <span class="data-row__text">
              回收站中有 <strong>{{ trashCount }}</strong> 个已删除会话
            </span>
            <NPopconfirm :disabled="trashCount === 0" @positive-click="onPurgeTrash">
              <template #trigger>
                <NButton size="small" tertiary type="error" :disabled="trashCount === 0">
                  清空回收站
                </NButton>
              </template>
              将彻底删除回收站中的 {{ trashCount }} 个会话及其消息，且无法恢复。确定吗？
            </NPopconfirm>
          </div>
        </NCard>

        <NCard size="small" class="settings-card">
          <template #header>
            <span>诊断与日志</span>
          </template>
          <p class="settings-card__desc">
            日志记录主进程运行信息，崩溃转储在应用异常退出时生成。可在此查看目录排查问题。
          </p>
          <div class="data-row">
            <div class="data-row__info">
              <span class="data-row__label">日志目录</span>
              <code class="data-row__path">{{ diagInfo?.logDir }}</code>
            </div>
            <NSpace :size="8" align="center">
              <NButton size="small" tertiary :disabled="!diagInfo" @click="openDiagDir('logs')">
                打开
              </NButton>
              <NPopconfirm @positive-click="onClearLogs">
                <template #trigger>
                  <NButton size="small" tertiary type="error">清空</NButton>
                </template>
                将清空日志文件内容，确定吗？
              </NPopconfirm>
            </NSpace>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">崩溃转储目录</span>
              <code class="data-row__path">{{ diagInfo?.crashDumpsDir }}</code>
            </div>
            <NButton size="small" tertiary :disabled="!diagInfo" @click="openDiagDir('crashes')">
              打开
            </NButton>
          </div>
          <div class="data-row data-row--gap">
            <div class="data-row__info">
              <span class="data-row__label">应用版本</span>
            </div>
            <span class="data-row__text">{{ appVersion }}</span>
          </div>
        </NCard>
      </div>

      <!-- ========== 关于 ========== -->
      <div v-show="activeTab === 'about'" class="settings-content__inner">
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
                  <span v-if="appVersion" class="about__version">v{{ appVersion }}</span>
                </p>
              </div>
            </div>

            <section class="about__section">
              <h3 class="about__heading">简介</h3>
              <p class="about__text">
                基于 <code>Electron</code> + <code>Vue 3</code> +
                <code>TypeScript</code> 构建的桌面端 AI 对话助手。支持多家模型服务商与自定义
                OpenAI/Anthropic 兼容端点，API Key 经系统安全存储加密，不会离开你的设备。
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

      <!-- 添加 / 编辑模型对话框 -->
      <AddModelDialog v-model:show="dialogShow" :editing="editing" />
    </NScrollbar>
  </div>
</template>

<style scoped>
/* 整体：左侧导航 + 右侧内容 */
.settings-view {
  flex: 1;
  min-width: 0;
  display: flex;
  height: 100%;
}

/* ===== 左侧导航 ===== */
.settings-nav {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  height: 100%;
}
.settings-nav__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 16px 16px 10px;
  cursor: pointer;
}
.settings-nav__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-1);
}
.settings-nav__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
}
.settings-nav__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.settings-nav__item:hover {
  background: var(--hover-bg);
  color: var(--text-1);
}
.settings-nav__item--active {
  background: var(--primary-soft);
  color: var(--primary-pressed);
  font-weight: 600;
}
.settings-nav__icon {
  flex-shrink: 0;
}

/* ===== 右侧内容 ===== */
.settings-content {
  flex: 1;
  min-width: 0;
}
.settings-content__inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 40px 40px;
}
.settings-card {
  margin-bottom: 16px;
}
.settings-card__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 模型列表 */
.model-empty {
  padding: 20px 12px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
  margin-bottom: 12px;
}
.model-empty__text {
  margin: 0;
  font-size: 13px;
  color: var(--text-3);
}
.model-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.model-list__item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-soft);
}
.model-list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.model-list__info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.model-list__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.model-list__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  flex-wrap: wrap;
}
.model-add {
  margin-top: 12px;
}

/* 数据管理 */
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
.data-row__text {
  font-size: 13px;
  color: var(--text-2);
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
.data-row__path {
  font-size: 11px;
  color: var(--text-3);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 380px;
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
