<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import {
  NCard,
  NSwitch,
  NButton,
  NSpace,
  NRadioGroup,
  NRadioButton,
  NInputNumber,
  useMessage
} from 'naive-ui'
import { useSettingsStore } from '@renderer/store/useSettingsStore'
import { useThemeStore, type ThemeMode } from '@renderer/store/useThemeStore'
import { useWindowStore } from '@renderer/store/useWindowStore'
import { mainClient } from '@renderer/utils/main-client'
import ThemeColorPicker from './ThemeColorPicker.vue'
import type { TitleBarMode } from '@main/agent/types'

const settings = useSettingsStore()
const theme = useThemeStore()
const windowStore = useWindowStore()
const message = useMessage()

/** 开机自启状态（登录项由系统持久化）。 */
const autoLaunch = ref(false)

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

/** 全局默认主题色（工作区未单独设置时跟随）。 */
const defaultColor = ref<string | null>(null)

async function onDefaultColorChange(key: string | null): Promise<void> {
  if (!key || key === defaultColor.value) return
  try {
    await mainClient.theme.setColor(null, key)
    defaultColor.value = key
    message.success('默认主题色已更新')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(async () => {
  autoLaunch.value = await mainClient.app.getAutoLaunch()
  // 设置窗口不绑定工作区：getPalette(null) 即全局默认
  defaultColor.value = (await mainClient.theme.getPalette(null)).key
})
</script>

<template>
  <div>
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
          <span class="data-row__label">默认主题色</span>
          <span class="data-row__hint">未单独设置主题色的工作区使用此颜色</span>
        </div>
        <ThemeColorPicker
          :model-value="defaultColor"
          @update:model-value="onDefaultColorChange"
        />
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
            关闭按钮会真正关闭窗口；开启后全部窗口关闭时应用保留在系统托盘，后台任务继续运行，可从托盘随时唤回
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
