<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NIcon, NTag } from 'naive-ui'
import { HelpCircleOutline, TimerOutline } from '@vicons/ionicons5'
import { usePermissionStore } from '@renderer/store/usePermissionStore'
import { useChatStore } from '@renderer/store/useChatStore'

/**
 * 权限批量确认条：展示在当前会话输入框上方，是「待确认操作」的唯一决策入口。
 * beforeToolCall 严格串行，待确认请求一次只到达一个，但请求里携带本条消息需要确认的
 * 整批操作（batch），因此这里能一次列全所有命令/路径，供用户看到全部内容后统一决策：
 * - 多条操作：允许本批全部（scope='batch' 放行）/ 拒绝本批全部（scope='batch' 拒绝），
 *   对同一条消息内剩余工具一次性生效，进入下一条消息即失效；
 * - 单条操作：提供逐项作用域（本次 / 本会话 / 总是允许）。
 * 破坏性命令始终强制单独确认，不受本批放行覆盖。
 */
const permissionStore = usePermissionStore()
const chatStore = useChatStore()

const currentSessionId = computed(() => chatStore.currentSessionId)
const pending = computed(() => permissionStore.pendingForSession(currentSessionId.value))
const count = computed(() => pending.value.length)

/** 当前待确认请求（串行流下一次只有一个，其 batch 字段携带整批明细）。 */
const current = computed(() => pending.value[0])
const batch = computed(() => current.value?.batch ?? [])
const batchLen = computed(() => batch.value.length)
const hasDenyHit = computed(() => batch.value.some((i) => i.denyHit))

/** 本次会话允许：整批无破坏性项才提供（破坏性命令不可被会话放行覆盖）。 */
const canSessionAllow = computed(() => !hasDenyHit.value)

/** 总是允许：仅当整批全是 bash 且未命中破坏性（持久白名单只支持 bash 非破坏性命令）。 */
const canAlwaysAllow = computed(() => {
  const items = batch.value
  return items.length > 0 && items.every((i) => i.toolName === 'bash' && !i.denyHit)
})

/** 允许（批 >1 时放行整批；单条按本次放行）。 */
function onAllow(): void {
  permissionStore.respondAll(currentSessionId.value, true, batchLen.value > 1 ? 'batch' : 'once')
}

/* ===== 倒计时：按请求携带的 expiresAt（0 = 一直等待）显示剩余秒数 ===== */
/** 每秒刷新一次的当前时间（仅存在待确认请求时走表）。 */
const now = ref(Date.now())
let tickTimer: number | undefined

watch(count, (c) => {
  if (c > 0 && tickTimer === undefined) {
    tickTimer = window.setInterval(() => (now.value = Date.now()), 1000)
  } else if (c === 0 && tickTimer !== undefined) {
    window.clearInterval(tickTimer)
    tickTimer = undefined
  }
})

onBeforeUnmount(() => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer)
})

/** 剩余秒数（向上取整）；一直等待（expiresAt = 0）时为 null，不显示倒计时。 */
const remainingSec = computed<number | null>(() => {
  const expiresAt = current.value?.expiresAt ?? 0
  if (expiresAt <= 0) return null
  return Math.max(0, Math.ceil((expiresAt - now.value) / 1000))
})

/** 拒绝（批 >1 时拒绝整批；单条按本次拒绝）。 */
function onReject(): void {
  permissionStore.respondAll(currentSessionId.value, false, batchLen.value > 1 ? 'batch' : 'once')
}

/** 单条/整批：本会话内对相同命令/路径放行（整批记录批内全部）。 */
function onAllowSession(): void {
  permissionStore.respondAll(
    currentSessionId.value,
    true,
    batchLen.value > 1 ? 'batch-session' : 'session'
  )
}

/** 单条/整批：加入持久白名单（仅 bash 非破坏性；整批记录批内全部）。 */
function onAllowAlways(): void {
  permissionStore.respondAll(
    currentSessionId.value,
    true,
    batchLen.value > 1 ? 'batch-always' : 'always'
  )
}
</script>

<template>
  <Transition name="perm-bar">
    <div v-if="count > 0" class="perm-bar">
      <div class="perm-bar__head">
        <span class="perm-bar__title">
          <NIcon :size="14" class="perm-bar__icon"><HelpCircleOutline /></NIcon>
          AI 请求执行以下 {{ batchLen }} 个操作
        </span>
        <span v-if="hasDenyHit" class="perm-bar__hint">含破坏性命令，需仔细确认</span>
        <!-- 倒计时：超时到点自动拒绝；一直等待（未设超时）时不显示 -->
        <span v-if="remainingSec !== null" class="perm-bar__countdown" title="到点未确认将自动拒绝">
          <NIcon :size="13"><TimerOutline /></NIcon>
          {{ remainingSec }}s 后自动拒绝
        </span>
      </div>

      <!-- 整批操作列表：决策前一次列全命令/路径 -->
      <div class="perm-bar__list">
        <div
          v-for="item in batch"
          :key="item.toolCallId"
          class="perm-bar__item"
          :class="{ 'perm-bar__item--deny': item.denyHit }"
        >
          <NTag size="tiny" :type="item.denyHit ? 'error' : 'default'" :bordered="false">
            {{ item.toolName }}
          </NTag>
          <code class="perm-bar__cmd" :title="item.summary">{{
            item.summary || '（无参数）'
          }}</code>
          <span v-if="item.denyHit" class="perm-bar__deny" title="命中破坏性命令规则，强制单独确认">
            破坏性
          </span>
        </div>
      </div>

      <div class="perm-bar__actions">
        <template v-if="batchLen > 1">
          <NButton size="small" type="success" title="放行本条消息内的全部操作" @click="onAllow">
            允许一次
          </NButton>
          <NButton size="small" title="拒绝本条消息内的全部操作" @click="onReject">
            拒绝全部
          </NButton>
          <NButton
            v-if="canSessionAllow"
            size="small"
            secondary
            title="放行整批，并把批内每条命令/路径记入本会话放行"
            @click="onAllowSession"
          >
            本次会话允许
          </NButton>
          <NButton
            v-if="canAlwaysAllow"
            size="small"
            secondary
            type="warning"
            title="放行整批，并把批内每条命令加入持久白名单"
            @click="onAllowAlways"
          >
            允许并添加到白名单
          </NButton>
        </template>
        <template v-else>
          <NButton size="small" type="success" @click="onAllow">允许</NButton>
          <NButton size="small" @click="onReject">拒绝</NButton>
          <NButton v-if="canSessionAllow" size="small" secondary @click="onAllowSession">
            本次会话允许
          </NButton>
          <NButton
            v-if="canAlwaysAllow"
            size="small"
            secondary
            type="warning"
            @click="onAllowAlways"
          >
            总是允许
          </NButton>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.perm-bar {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--warning-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.perm-bar__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.perm-bar__title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}
.perm-bar__icon {
  color: var(--warning);
  flex-shrink: 0;
}
.perm-bar__hint {
  font-size: 12px;
  color: var(--warning);
}
/* 倒计时（超时自动拒绝提示）：弱化展示在头部右侧 */
.perm-bar__countdown {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.perm-bar__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 168px;
  overflow-y: auto;
}
.perm-bar__item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 6px;
}
.perm-bar__item--deny {
  background: var(--error-soft);
}
.perm-bar__cmd {
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
.perm-bar__deny {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--error);
}
.perm-bar__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
/* 出现/消失淡入淡出 */
.perm-bar-enter-active,
.perm-bar-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.perm-bar-enter-from,
.perm-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
