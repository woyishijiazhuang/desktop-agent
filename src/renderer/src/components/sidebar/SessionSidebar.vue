<script setup lang="ts">
import { ref, computed, watch, nextTick, h, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { NScrollbar, NButton, NIcon, NInput, NModal, useDialog, useMessage } from 'naive-ui'
import {
  AddOutline,
  ChatbubbleEllipsesOutline,
  SettingsOutline,
  InformationCircleOutline,
  ArchiveOutline,
  SearchOutline,
  SunnyOutline,
  MoonOutline
} from '@vicons/ionicons5'
import { formatContextWindow, formatTokens } from '@renderer/utils/format'
import { useSessionStore } from '@renderer/store/useSessionStore'
import { useChatStore } from '@renderer/store/useChatStore'
import { useThemeStore } from '@renderer/store/useThemeStore'
import { mainClient } from '@renderer/utils/main-client'
import AboutDialog from '@renderer/components/AboutDialog.vue'
import SessionItem from './SessionItem.vue'
import type { Session, MessageSearchHit, SessionExportFormat } from '@main/service/db-service'

/**
 * 左侧会话侧栏：新建 / 切换 / 重命名 / 删除会话 + 压缩当前会话历史。
 * - 「新建对话」进入临时空对话（不写库），首条消息发送时才落库
 * - 会话项 hover 显示 ⋯ 菜单：重命名（弹窗）/ 删除（确认）
 * - 按日期分组（今天/昨天/7天内/30天内/更早）+ 顶部搜索框
 * - 底部入口：主题切换 / 压缩历史 / 设置（路由页）/ 关于（弹窗）
 */
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const themeStore = useThemeStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()

/** 压缩进行中（禁用按钮，避免重复触发）。 */
const compressing = ref(false)
/** 关于弹窗显示。 */
const aboutShow = ref(false)
/** 搜索关键词。 */
const query = ref('')

/** 重命名弹窗状态。 */
const renameShow = ref(false)
const renameId = ref<string | null>(null)
const renameValue = ref('')
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null)

/** 按最后用户活动时间（last_active_at）倒序的会话列表。后台流式/自动标题不更新，
 *  仅发消息等对话活动置顶（切换会话不 touch，列表在连续点击时保持稳定不跳动）。 */
const sortedSessions = computed(() =>
  [...sessionStore.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
)

const isSearching = computed(() => query.value.trim().length > 0)

/** 按标题过滤后的会话列表（搜索模式使用）。 */
const filteredSessions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sortedSessions.value
  return sortedSessions.value.filter((s) => s.title.toLowerCase().includes(q))
})

/** 全文搜索消息命中列表（防抖查询，仅搜索模式使用）。 */
const messageHits = ref<MessageSearchHit[]>([])
let searchTimer: ReturnType<typeof setTimeout> | undefined

// 搜索词变化时防抖调用主进程全文搜索消息内容
watch(query, (q) => {
  clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    messageHits.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    try {
      messageHits.value = await mainClient.db.searchMessages(trimmed)
    } catch {
      messageHits.value = []
    }
  }, 250)
})

onUnmounted(() => clearTimeout(searchTimer))

interface SessionGroup {
  label: string
  items: Session[]
}

/** 将会话按更新时间分桶：今天/昨天/7天内/30天内/更早。 */
function groupByDate(sessions: Session[]): SessionGroup[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  const buckets: SessionGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '7 天内', items: [] },
    { label: '30 天内', items: [] },
    { label: '更早', items: [] }
  ]
  for (const s of sessions) {
    const ts = s.lastActiveAt
    if (ts >= startOfToday) buckets[0].items.push(s)
    else if (ts >= startOfToday - day) buckets[1].items.push(s)
    else if (ts >= startOfToday - 7 * day) buckets[2].items.push(s)
    else if (ts >= startOfToday - 30 * day) buckets[3].items.push(s)
    else buckets[4].items.push(s)
  }
  return buckets.filter((g) => g.items.length > 0)
}

/**
 * 渲染用分组：
 * - 搜索时：仅「会话」组（标题匹配），消息命中单独渲染（见模板 message-hits 区）。
 * - 非搜索：置顶组（置顶且未归档）→ 日期组（常规）→ 已归档组（归档会话）。
 */
const groupedSessions = computed<SessionGroup[]>(() => {
  if (isSearching.value) {
    return filteredSessions.value.length > 0
      ? [{ label: '会话', items: filteredSessions.value }]
      : []
  }
  const sorted = sortedSessions.value
  const groups: SessionGroup[] = []
  const pinned = sorted.filter((s) => s.pinned && !s.archived)
  const normal = sorted.filter((s) => !s.pinned && !s.archived)
  const archived = sorted.filter((s) => s.archived)
  if (pinned.length > 0) groups.push({ label: '置顶', items: pinned })
  groups.push(...groupByDate(normal))
  if (archived.length > 0) groups.push({ label: '已归档', items: archived })
  return groups
})

/** 是否无任何搜索命中（会话 + 消息均无）。 */
const noSearchResult = computed(
  () => filteredSessions.value.length === 0 && messageHits.value.length === 0
)

/** 当前会话是否可压缩：存在当前会话且不在压缩中（对话进行中仅静默忽略点击，不改外观）。 */
const canCompress = computed(() => !!sessionStore.currentSessionId && !compressing.value)

/** 消息角色展示名。 */
function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '助手'
  if (role === 'toolResult') return '工具'
  return role
}

async function onNew(): Promise<void> {
  await sessionStore.startNewChat()
}

async function onSelect(session: Session): Promise<void> {
  // 点击已归档会话：先取消归档再进入（主流产品惯例，归档会话不该停留在已归档组）
  if (session.archived) {
    await sessionStore.setArchived(session.id, false)
  }
  await sessionStore.select(session.id)
}

/**
 * 点击消息搜索结果：切换到所属会话，并加载包含命中消息的窗口、滚动定位 + 高亮。
 * 目标消息就在当前会话当前窗口时，jumpToMessage 仅发定位信号（不重载、不打断流）。
 */
async function onSelectHit(hit: MessageSearchHit): Promise<void> {
  const session = sessionStore.sessions.find((s) => s.id === hit.sessionId)
  if (session) {
    await onSelect(session)
  } else {
    await sessionStore.select(hit.sessionId)
  }
  await chatStore.jumpToMessage(hit.sessionId, hit.messageId)
}

function onMenu(key: string, session: Session): void {
  if (key === 'pin') void sessionStore.setPinned(session.id, !session.pinned)
  else if (key === 'archive') void sessionStore.setArchived(session.id, !session.archived)
  else if (key === 'export-md') void onExport(session, 'markdown')
  else if (key === 'export-json') void onExport(session, 'json')
  else if (key === 'rename') openRename(session)
  else if (key === 'delete') confirmDelete(session)
}

/** 导出会话为 Markdown / JSON（主进程弹保存对话框并写文件）。 */
async function onExport(session: Session, format: SessionExportFormat): Promise<void> {
  try {
    const path = await mainClient.db.exportSession(session.id, format)
    if (path) message.success(`已导出到 ${path}`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function openRename(session: Session): void {
  renameId.value = session.id
  renameValue.value = session.title
  renameShow.value = true
}

/** 确认重命名：空标题不关闭；返回 false 阻止 NDialog 自动关闭，由 renameShow 手动控制。 */
async function onRenameConfirm(): Promise<boolean> {
  const id = renameId.value
  const title = renameValue.value.trim()
  if (!id || !title) return false
  renameShow.value = false
  await sessionStore.renameSession(id, title)
  return false
}

function confirmDelete(session: Session): void {
  dialog.warning({
    title: '删除会话',
    content: `「${session.title}」删除后不可恢复，确认删除？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await sessionStore.deleteSession(session.id)
    }
  })
}

// 弹窗打开后聚焦输入框并全选，便于直接覆盖原标题
watch(renameShow, async (show) => {
  if (show) {
    await nextTick()
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  }
})

function goToSettings(): void {
  void router.push('/settings')
}

/** 当前会话上下文占用（手动压缩确认弹窗展示用）。 */
interface SessionContextUsage {
  contextWindow: number
  threshold: number
  summaryTokens: number
  activeTokens: number
}

/**
 * 压缩当前会话历史：先查询当前上下文占用，在确认弹窗中展示后由用户确认，
 * 确认后调用主进程压缩，完成后重新加载消息列表。
 */
async function onCompress(): Promise<void> {
  const sessionId = sessionStore.currentSessionId
  // 对话进行中不压缩（按钮外观不变，仅静默忽略点击）
  if (!sessionId || compressing.value || chatStore.isBusy) return
  let usage: SessionContextUsage
  try {
    usage = await mainClient.agent.getSessionContextUsage(sessionId)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
    return
  }
  const { contextWindow, threshold, summaryTokens, activeTokens } = usage
  const total = summaryTokens + activeTokens
  // 占用百分比：大窗口下占比很小，四舍五入会显示成 0%，<10% 时保留小数
  const pct = contextWindow > 0 ? (total / contextWindow) * 100 : null
  const percentText =
    pct === null
      ? null
      : pct >= 10
        ? `${Math.round(pct)}%`
        : pct >= 1
          ? `${Math.round(pct * 10) / 10}%`
          : `${Math.round(pct * 100) / 100}%`
  dialog.warning({
    title: '压缩会话历史',
    content: () =>
      h(
        'div',
        { style: 'line-height: 1.8' },
        [
          percentText === null
            ? '当前模型未配置上下文窗口，无法估算占用。'
            : `当前上下文已占用约 ${percentText}（自动压缩阈值 ${threshold}%，超过即自动压缩）`,
          `摘要 ${formatTokens(summaryTokens)} tokens · 活跃消息 ${formatTokens(activeTokens)} tokens` +
            (contextWindow > 0 ? `（模型窗口 ${formatContextWindow(contextWindow)}）` : ''),
          '压缩后较早历史将合并为摘要，仅保留最近若干条消息，不可恢复。'
        ].map((line) => h('div', null, line))
      ),
    positiveText: '压缩',
    negativeText: '取消',
    onPositiveClick: () => {
      // 同步返回，弹窗随即关闭；压缩在后台进行，结果用 toast 反馈。
      // 之前 await 在 onPositiveClick 里会让弹窗长时间挂起且无 loading，用户重复点击
      // 导致同一会话被并发压缩，后写入方乐观锁报「版本号不匹配」。
      void runCompress(sessionId)
    }
  })
}

/**
 * 后台执行压缩：结果用 toast 反馈，完成后重新加载消息列表。
 * compressing.value 防重入：压缩进行中再次点「压缩」按钮会被 onCompress 忽略。
 */
async function runCompress(sessionId: string): Promise<void> {
  if (compressing.value) return
  compressing.value = true
  try {
    const result = await mainClient.agent.compressSession(sessionId)
    if (!result.compressed) {
      // 无新增可压缩内容：非错误，普通提示即可
      message.info(result.reason ?? '暂无需要压缩的内容')
      return
    }
    // 压缩后 main 会驱逐 Agent 实例；重新加载会话消息以反映压缩后的列表
    await chatStore.loadSession(sessionId)
    message.success('已压缩历史')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    compressing.value = false
  }
}

/** 会话是否正在后台生成（侧边栏状态指示）。 */
function isSessionBusy(id: string): boolean {
  return !!chatStore.sessionState(id)?.isBusy
}

/** 会话上一轮是否失败（非生成中，侧边栏红点指示）。 */
function isSessionFailed(id: string): boolean {
  const st = chatStore.sessionState(id)
  return !!st && !st.isBusy && st.lastTurnFailed
}
</script>

<template>
  <aside class="sidebar">
    <!-- 顶部：搜索 + 新建对话 -->
    <div class="sidebar__top">
      <NInput
        v-model:value="query"
        class="sidebar__search"
        size="small"
        placeholder="搜索会话或消息"
        :input-props="{ autocomplete: 'off' }"
        clearable
      >
        <template #prefix>
          <NIcon :size="14" class="sidebar__search-icon"><SearchOutline /></NIcon>
        </template>
      </NInput>
      <NButton class="sidebar__new" tertiary size="small" @click="onNew">
        <template #icon>
          <NIcon><AddOutline /></NIcon>
        </template>
        新建对话
      </NButton>
    </div>

    <NScrollbar class="sidebar__list" :content-style="{ padding: '4px 6px 8px' }">
      <!-- 搜索模式：消息全文命中 -->
      <div v-if="isSearching && messageHits.length > 0" class="sidebar__group">
        <div class="sidebar__group-label">消息</div>
        <div
          v-for="hit in messageHits"
          :key="hit.messageId"
          class="search-hit"
          @click="onSelectHit(hit)"
        >
          <div class="search-hit__title">
            <NIcon :size="13" class="search-hit__icon"><ChatbubbleEllipsesOutline /></NIcon>
            <span class="search-hit__name">{{ hit.sessionTitle }}</span>
            <span class="search-hit__role">{{ roleLabel(hit.role) }}</span>
          </div>
          <div class="search-hit__snippet">{{ hit.snippet }}</div>
        </div>
      </div>

      <div v-for="group in groupedSessions" :key="group.label" class="sidebar__group">
        <div class="sidebar__group-label">{{ group.label }}</div>
        <SessionItem
          v-for="session in group.items"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          :busy="isSessionBusy(session.id)"
          :failed="isSessionFailed(session.id)"
          @select="onSelect(session)"
          @action="(key: string) => onMenu(key, session)"
        />
      </div>

      <div
        v-if="filteredSessions.length === 0 && (!isSearching || messageHits.length === 0)"
        class="sidebar__empty"
      >
        {{ isSearching ? (noSearchResult ? '未找到相关会话或消息' : '无匹配会话') : '无会话' }}
      </div>
    </NScrollbar>

    <!-- 底部：主题 / 压缩历史 / 设置 / 关于 -->
    <div class="sidebar__footer">
      <NButton
        quaternary
        circle
        size="small"
        class="sidebar__foot-btn"
        :title="themeStore.isDark ? '切换到浅色' : '切换到深色'"
        @click="themeStore.toggle()"
      >
        <template #icon>
          <NIcon><SunnyOutline v-if="themeStore.isDark" /><MoonOutline v-else /></NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        circle
        size="small"
        class="sidebar__foot-btn"
        title="压缩当前会话历史"
        :disabled="!canCompress"
        :loading="compressing"
        @click="onCompress"
      >
        <template #icon>
          <NIcon><ArchiveOutline /></NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        circle
        size="small"
        class="sidebar__foot-btn"
        title="设置"
        @click="goToSettings"
      >
        <template #icon>
          <NIcon><SettingsOutline /></NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        circle
        size="small"
        class="sidebar__foot-btn"
        title="关于"
        @click="aboutShow = true"
      >
        <template #icon>
          <NIcon><InformationCircleOutline /></NIcon>
        </template>
      </NButton>
    </div>

    <!-- 重命名弹窗：NModal preset="dialog" 自带 teleport 到 body + 居中遮罩 -->
    <NModal
      v-model:show="renameShow"
      preset="dialog"
      title="重命名会话"
      :show-icon="false"
      positive-text="保存"
      negative-text="取消"
      @positive-click="onRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        placeholder="输入会话标题"
        maxlength="60"
        @keydown.enter="onRenameConfirm"
      />
    </NModal>

    <AboutDialog v-model:show="aboutShow" />
  </aside>
</template>

<style scoped>
.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--bg-soft);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.sidebar__top {
  padding: 10px 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sidebar__new {
  width: 100%;
  justify-content: flex-start;
  font-weight: 600;
}
.sidebar__search-icon {
  color: var(--text-3);
}
.sidebar__list {
  flex: 1;
  min-height: 0;
}
.sidebar__group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  padding: 10px 10px 4px;
  letter-spacing: 0.02em;
}
.sidebar__empty {
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
  padding: 24px 0;
}
.sidebar__footer {
  padding: 8px 10px;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 4px;
}
.sidebar__foot-btn {
  --n-size: 30px;
}

/* ===== 消息搜索结果项 ===== */
.search-hit {
  padding: 7px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.1s ease;
}
.search-hit:hover {
  background: var(--hover-bg);
}
.search-hit__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.search-hit__icon {
  color: var(--text-3);
  flex-shrink: 0;
}
.search-hit__name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.search-hit__role {
  font-size: 10px;
  color: var(--text-3);
  background: var(--bg-mute);
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}
.search-hit__snippet {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
  margin-top: 3px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}
</style>
