<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NInput, NTag } from 'naive-ui'
import { HelpCircleOutline, TimerOutline, DocumentTextOutline } from '@vicons/ionicons5'
import { useInteractionStore } from '@renderer/store/useInteractionStore'
import { useChatStore } from '@renderer/store/useChatStore'
import type {
  AskUserRequest,
  InteractionRequest,
  PlanApprovalRequest,
  ToolPermissionRequest
} from '@main/agent/types'

/**
 * 统一「人工介入」条（危险工具确认 / 计划审批 / 澄清提问 三合一，取代原
 * PermissionBar / PlanApprovalBar / AskUserBar 三个独立组件）：
 * - 全部请求走同一条队列（useInteractionStore），同一外观、同一倒计时口径；
 * - 超时源统一：main 按 permission.timeoutSec 处理，请求携带 expiresAt（0=一直等待），
 *   本组件据此显示剩余秒数，到点由 store 清理（权限卡翻转为拒绝态）。
 * scope 收敛为 once/session/always：破坏性命令只给「允许/拒绝」，不给会话/总是放行。
 */
const interactionStore = useInteractionStore()
const chatStore = useChatStore()

const sessionId = computed(() => chatStore.currentSessionId)
const pending = computed(() => interactionStore.pendingForSession(sessionId.value))
const current = computed(() => pending.value[0] ?? null)
const queueLen = computed(() => pending.value.length)

/* ===== 当前交互 ===== */
function isPermission(r: InteractionRequest | null): r is ToolPermissionRequest {
  return r?.kind === 'tool_permission'
}
function isPlan(r: InteractionRequest | null): r is PlanApprovalRequest {
  return r?.kind === 'plan_approval'
}
function isAsk(r: InteractionRequest | null): r is AskUserRequest {
  return r?.kind === 'ask_question'
}

/* 权限操作可选项（作用域收敛为 3 种） */
const permissionCurrent = computed<ToolPermissionRequest | null>(() =>
  isPermission(current.value) ? current.value : null
)
/** 破坏性命令：强制单独确认，不给会话/总是。 */
const denyHit = computed(() => permissionCurrent.value?.denyHit ?? false)
/** 总是允许：仅 bash 且未命中破坏性（持久白名单只支持 bash 非破坏性命令）。 */
const canAlwaysAllow = computed(() => {
  const c = permissionCurrent.value
  return !!c && !c.denyHit && c.toolName === 'bash'
})

function respondPermission(approved: boolean, scope: 'once' | 'session' | 'always' = 'once'): void {
  const c = permissionCurrent.value
  if (!c || !sessionId.value) return
  interactionStore.respondPermission(c, approved, scope)
}

/** 队列异常堆积（多批串行前的极端情况）时的一次性兜底：全部放行/拒绝。 */
function respondAllPermission(approved: boolean): void {
  for (const r of pending.value) {
    if (isPermission(r)) interactionStore.respondPermission(r, approved, 'once')
  }
}

/* ===== 计划审批 ===== */
const planFeedback = ref('')
function onPlanApprove(): void {
  const c = current.value
  if (!isPlan(c) || !sessionId.value) return
  interactionStore.respondPlan(c, true, '')
}
function onPlanReject(): void {
  const c = current.value
  if (!isPlan(c) || !sessionId.value) return
  interactionStore.respondPlan(c, false, planFeedback.value.trim())
  planFeedback.value = ''
}

/* ===== 澄清提问 ===== */
const askCustom = ref('')
const askSelected = ref<string | null>(null)
const askSelectedMulti = ref<string[]>([])
function toggleOption(value: string): void {
  const c = current.value
  if (!isAsk(c)) return
  if (c.multiSelect) {
    const i = askSelectedMulti.value.indexOf(value)
    if (i >= 0) askSelectedMulti.value.splice(i, 1)
    else askSelectedMulti.value.push(value)
  } else {
    askSelected.value = askSelected.value === value ? null : value
  }
}
function onAskSubmit(): void {
  const c = current.value
  if (!isAsk(c) || !sessionId.value) return
  if (c.multiSelect) {
    interactionStore.respondAskUser(
      c,
      askSelectedMulti.value.length > 0
        ? [...askSelectedMulti.value]
        : askCustom.value.trim() || null
    )
  } else {
    interactionStore.respondAskUser(c, askSelected.value ?? (askCustom.value.trim() || null))
  }
}
function onAskSkip(): void {
  const c = current.value
  if (!isAsk(c) || !sessionId.value) return
  interactionStore.respondAskUser(c, null)
}
const askCanSubmit = computed(() => {
  const c = current.value
  if (!isAsk(c)) return true
  return !(
    c.required &&
    !askCustom.value.trim() &&
    askSelected.value === null &&
    askSelectedMulti.value.length === 0
  )
})

/* ===== 统一倒计时（0=一直等待时不显示） ===== */
const now = ref(Date.now())
let tickTimer: number | undefined
watch(
  () => pending.value.length,
  (n) => {
    if (n > 0 && tickTimer === undefined) {
      tickTimer = window.setInterval(() => (now.value = Date.now()), 1000)
    } else if (n === 0 && tickTimer !== undefined) {
      window.clearInterval(tickTimer)
      tickTimer = undefined
    }
  }
)
watch(current, () => {
  planFeedback.value = ''
  askCustom.value = ''
  askSelected.value = null
  askSelectedMulti.value = []
})
const remainingSec = computed<number | null>(() => {
  const expiresAt = current.value?.expiresAt ?? 0
  if (expiresAt <= 0) return null
  return Math.max(0, Math.ceil((expiresAt - now.value) / 1000))
})
</script>

<template>
  <Transition name="interaction-bar">
    <div v-if="current" class="interaction-bar">
      <!-- ============ 1. 危险工具确认 ============ -->
      <div v-if="isPermission(current)" class="interaction-panel">
        <div class="interaction-panel__head">
          <span class="interaction-panel__title">
            <NIcon :size="14" class="interaction-panel__icon--warn"><HelpCircleOutline /></NIcon>
            AI 请求执行以下操作
          </span>
          <span v-if="denyHit" class="interaction-panel__hint"
            >命中破坏性命令规则，强制单独确认</span
          >
          <span
            v-if="remainingSec !== null"
            class="interaction-panel__countdown"
            title="到点未确认将自动拒绝"
          >
            <NIcon :size="13"><TimerOutline /></NIcon>
            {{ remainingSec }}s 后自动拒绝
          </span>
        </div>

        <div class="interaction-panel__list">
          <div
            v-for="item in pending"
            :key="item.requestId"
            class="interaction-panel__row"
            :class="{ 'interaction-panel__row--deny': isPermission(item) && item.denyHit }"
          >
            <template v-if="isPermission(item)">
              <NTag size="tiny" :type="item.denyHit ? 'error' : 'default'" :bordered="false">
                {{ item.toolName }}
              </NTag>
              <code class="interaction-panel__cmd" :title="item.summary">{{
                item.summary || '（无参数）'
              }}</code>
              <span v-if="item.denyHit" class="interaction-panel__deny">破坏性</span>
            </template>
          </div>
          <span v-if="queueLen > 1" class="interaction-panel__queued">
            另有 {{ queueLen - 1 }} 项排队，将依次确认
          </span>
        </div>

        <div class="interaction-panel__actions">
          <template v-if="queueLen === 1">
            <NButton size="small" type="success" @click="respondPermission(true)">允许</NButton>
            <NButton size="small" @click="respondPermission(false)">拒绝</NButton>
            <NButton
              v-if="!denyHit"
              size="small"
              secondary
              @click="respondPermission(true, 'session')"
            >
              本次会话允许
            </NButton>
            <NButton
              v-if="canAlwaysAllow"
              size="small"
              secondary
              type="warning"
              @click="respondPermission(true, 'always')"
            >
              总是允许
            </NButton>
          </template>
          <template v-else>
            <NButton size="small" type="success" @click="respondAllPermission(true)"
              >全部允许</NButton
            >
            <NButton size="small" @click="respondAllPermission(false)">全部拒绝</NButton>
          </template>
        </div>
      </div>

      <!-- ============ 2. 计划审批 ============ -->
      <div v-else-if="isPlan(current)" class="interaction-panel">
        <div class="interaction-panel__head">
          <span class="interaction-panel__title">
            <NIcon :size="14" class="interaction-panel__icon--warn"><DocumentTextOutline /></NIcon>
            AI 提交了计划：{{ current.title }}
          </span>
          <NTag size="tiny" type="warning" :bordered="false">待审批</NTag>
          <span
            v-if="remainingSec !== null"
            class="interaction-panel__countdown"
            title="到点未审批将自动拒绝"
          >
            <NIcon :size="13"><TimerOutline /></NIcon>
            {{ remainingSec }}s 后自动拒绝
          </span>
        </div>

        <pre class="interaction-panel__plan">{{ current.plan }}</pre>

        <div class="interaction-panel__feedback">
          <NInput
            v-model:value="planFeedback"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            placeholder="拒绝时可填写反馈，AI 将据此调整计划（批准无需填写）"
            size="small"
          />
        </div>

        <div class="interaction-panel__actions">
          <NButton
            size="small"
            type="success"
            title="批准计划，AI 开始执行（本轮危险操作自动放行）"
            @click="onPlanApprove"
          >
            批准
          </NButton>
          <NButton size="small" title="拒绝计划，AI 根据反馈调整后重新提交" @click="onPlanReject">
            拒绝
          </NButton>
        </div>
      </div>

      <!-- ============ 3. 澄清提问 ============ -->
      <div v-else-if="isAsk(current)" class="interaction-panel">
        <div class="interaction-panel__head">
          <span class="interaction-panel__title">
            <NIcon :size="14" class="interaction-panel__icon"><HelpCircleOutline /></NIcon>
            AI 想确认：{{ current.question }}
          </span>
          <NTag size="tiny" type="info" :bordered="false">
            {{ current.multiSelect ? '可多选' : '单选' }}{{ current.required ? ' · 必答' : '' }}
          </NTag>
          <span
            v-if="remainingSec !== null"
            class="interaction-panel__countdown"
            title="到点未作答将自动跳过"
          >
            <NIcon :size="13"><TimerOutline /></NIcon>
            {{ remainingSec }}s 后自动跳过
          </span>
        </div>

        <div v-if="current.options.length > 0" class="interaction-panel__options">
          <button
            v-for="opt in current.options"
            :key="opt.value"
            type="button"
            class="interaction-panel__option"
            :class="{
              'interaction-panel__option--active': current.multiSelect
                ? askSelectedMulti.includes(opt.value)
                : askSelected === opt.value
            }"
            @click="toggleOption(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>

        <div class="interaction-panel__custom">
          <NInput
            v-model:value="askCustom"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 3 }"
            :placeholder="
              current.options.length > 0 ? '或在此自由输入其他答案…' : '在此输入你的答案…'
            "
            size="small"
            @keydown.enter.exact.prevent="onAskSubmit"
          />
        </div>

        <div class="interaction-panel__actions">
          <NButton size="small" type="primary" :disabled="!askCanSubmit" @click="onAskSubmit">
            提交
          </NButton>
          <NButton
            v-if="!current.required"
            size="small"
            title="跳过此题，AI 基于已有信息继续"
            @click="onAskSkip"
          >
            跳过
          </NButton>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.interaction-bar {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.interaction-panel {
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--bg-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.interaction-panel__head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.interaction-panel__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
}
.interaction-panel__icon,
.interaction-panel__icon--warn {
  flex-shrink: 0;
}
.interaction-panel__icon {
  color: var(--primary);
}
.interaction-panel__icon--warn {
  color: var(--warning);
}
.interaction-panel__hint {
  font-size: 12px;
  color: var(--warning);
}
.interaction-panel__countdown {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.interaction-panel__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.interaction-panel__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
}
.interaction-panel__row--deny {
  background: var(--error-soft);
}
.interaction-panel__cmd {
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-mute);
  border-radius: 4px;
  padding: 2px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.interaction-panel__deny {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--error);
}
.interaction-panel__queued {
  font-size: 12px;
  color: var(--text-3);
}
.interaction-panel__plan {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--code-bg);
  font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.interaction-panel__options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.interaction-panel__option {
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
.interaction-panel__option:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.interaction-panel__option--active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.interaction-panel__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.interaction-panel__feedback,
.interaction-panel__custom {
  display: flex;
}
/* 出现/消失淡入淡出 */
.interaction-bar-enter-active,
.interaction-bar-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.interaction-bar-enter-from,
.interaction-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
