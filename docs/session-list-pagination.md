# 会话列表分页规划文档

> 本文档为「会话列表无限滚动分页」功能的详细设计方案，涵盖后端分页查询、前端分页状态管理、搜索适配、各功能影响分析与修改清单。审查通过后按本文档逐项实施。

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [现状分析](#2-现状分析)
3. [技术方案选型](#3-技术方案选型)
4. [后端分页接口设计](#4-后端分页接口设计)
5. [IPC 桥接层](#5-ipc-桥接层)
6. [前端 Store 分页状态管理](#6-前端-store-分页状态管理)
7. [前端组件：无限滚动 + 搜索适配](#7-前端组件无限滚动--搜索适配)
8. [各功能影响分析与处理方案](#8-各功能影响分析与处理方案)
9. [数据库变更](#9-数据库变更)
10. [修改文件清单](#10-修改文件清单)
11. [测试计划](#11-测试计划)

---

## 1. 背景与目标

### 问题

当前会话列表在 `load()` 时通过 `listSessions()` 一次性查询全部未删除会话到前端内存，随着用户积累的会话数量增多（数百甚至上千），存在以下问题：

1. **首次加载变慢**：SQLite 全表扫描 + 全部映射为对象 + IPC 传输
2. **前端内存占用**：所有会话元数据常驻内存
3. **排序稳定性**：前端对全量数据二次排序 + 分组计算，复杂度 O(n log n)

### 目标

- 首次加载仅查询最近 30 条会话（`PAGE_SIZE = 30`）
- 滚动到底部自动加载下一页（`IntersectionObserver` 哨兵）
- 支持会话标题搜索（后端 SQL `LIKE` 查询）
- 向后兼容：保留 `listSessions()` 全量接口供内部使用（附件清理等）

---

## 2. 现状分析

### 2.1 数据流

```
┌─────────────────────────────────────────────────────────────┐
│  SQLite (sessions 表)                                       │
│  ORDER BY pinned DESC, last_active_at DESC                  │
│  索引: idx_sessions_active(last_active_at)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    sessions.ts (listSessions)
                           │
                    db-service.ts (DbService.listSessions)
                           │
                     electron-ipc-service (IPC)
                           │
                    useSessionStore.load()
                    sessions.value = 全量 Session[]
                           │
                    SessionSidebar.vue
                    sortedSessions → groupByDate → groupedSessions
```

### 2.2 `sessionStore.sessions` 的所有使用点

| 文件 | 行号 | 操作 | 说明 |
|------|------|------|------|
| `useSessionStore.ts` | L25 | `sessions.value = await mainClient.db.listSessions()` | 全量加载 |
| `useSessionStore.ts` | L31 | `sessions.value.unshift(session)` | 创建会话插入头部 |
| `useSessionStore.ts` | L66-67 | `sessions.value[idx] = updated` | 重命名替换 |
| `useSessionStore.ts` | L73-74 | `sessions.value[idx] = updated` | 置顶替换 |
| `useSessionStore.ts` | L80-81 | `sessions.value[idx] = updated` | 归档替换 |
| `useSessionStore.ts` | L87 | `sessions.value = sessions.value.filter(...)` | 删除过滤 |
| `useSessionStore.ts` | L92 | `const next = sessions.value[0]` | 删除后选下一个 |
| `useSessionStore.ts` | L105-106 | `sessions.value[idx] = updated` | refreshSession |
| `useSessionStore.ts` | L114-118 | `findIndex` or `unshift` | upsert 推送更新 |
| `SessionSidebar.vue` | L54 | `[...sessionStore.sessions].sort(...)` | 排序复制 |
| `SessionSidebar.vue` | L172 | `sessionStore.sessions.find(...)` | 消息搜索跳转定位会话 |
| `ChatView.vue` | L78 | `sessionStore.sessions[0]` | 启动自动选择最近会话 |
| `useChatStore.ts` | L593 | `sessionStore.sessions.unshift(session)` | 分叉创建会话 |

### 2.3 其他使用 `listSessions()` 的主进程代码

| 文件 | 行号 | 说明 |
|------|------|------|
| `attachment.ts` | L154 | `for (const s of db.listSessions()) known.add(s.id)` — 孤儿附件清理 |

---

## 3. 技术方案选型

### 选定方案：游标分页 + IntersectionObserver 无限滚动

| 对比项 | Offset 分页 | 游标分页 (选定) |
|--------|------------|----------------|
| 性能 | 深偏移时退化为全表扫描 | 始终走索引，O(log n) |
| 数据变动 | 新增/删除会导致偏移错位 | 不受数据变动影响 |
| 实现复杂度 | 简单 | 略复杂（需复合游标） |
| 跳页 | 支持 | 不支持（无限滚动无需跳页） |

**选择理由**：会话列表按 `last_active_at DESC` 排序，且会频繁 touch（发消息/重命名/换模型），游标分页不会因中间数据变动导致重复或遗漏。项目消息列表已有类似的分页模式（`beforeId` + `limit`），设计一致。

### 分页策略

- **排序键**：`last_active_at DESC`（与现有 `listSessions` 一致）
- **复合游标**：`(last_active_at, id)` — 防止相同时间戳的排序不稳定
- **每页大小**：`PAGE_SIZE = 30`
- **hasMore 判断**：`limit + 1` 技巧 — 请求 31 条，返回 > 30 则 `hasMore = true`
- **置顶会话**：始终在第一页返回（不分页），保证置顶项始终可见

---

## 4. 后端分页接口设计

### 4.1 新增类型

在 [src/main/database/types/session.ts](file:///Users/hupengfei/Documents/my-app/src/main/database/types/session.ts) 中新增：

```typescript
/** 会话列表分页参数。 */
export interface ListSessionsOptions {
  /** 每页大小（默认 30） */
  limit?: number
  /** 游标：上一页最后一条会话的 lastActiveAt（仅在非置顶区间使用） */
  cursor?: number
  /** 游标辅助：cursor 对应会话的 id（防同时间戳歧义） */
  cursorId?: string
}

/** 会话列表分页结果。 */
export interface ListSessionsResult {
  sessions: Session[]
  hasMore: boolean
}
```

### 4.2 修改 `SessionApi` 接口

在 [src/main/database/sessions.ts](file:///Users/hupengfei/Documents/my-app/src/main/database/sessions.ts#L9-L22) 中修改：

```typescript
export interface SessionApi {
  // ... 保留现有方法不变 ...
  listSessions(): Session[]                          // 保留：全量查询（附件清理等内部用）
  listSessionsPaged(options?: ListSessionsOptions): ListSessionsResult  // 新增：分页查询
  searchSessions(query: string, limit?: number): Session[]             // 新增：标题搜索
  // ... 其余不变 ...
}
```

### 4.3 `listSessionsPaged` 实现

```typescript
listSessionsPaged(options?: ListSessionsOptions): ListSessionsResult {
  const limit = options?.limit ?? 30
  const requestLimit = limit + 1  // 多取 1 条用于判断 hasMore

  // 第一步：取置顶会话（置顶会话始终全部返回，不参与分页）
  const pinnedRows = db.prepare(
    'SELECT * FROM sessions WHERE deleted_at IS NULL AND pinned = 1 ORDER BY last_active_at DESC'
  ).all() as unknown as SessionRow[]

  // 第二步：取非置顶会话（游标分页）
  let conditions = ['deleted_at IS NULL', 'pinned = 0']
  let values: (string | number)[] = []

  if (options?.cursor !== undefined && options?.cursorId) {
    // 复合游标：(last_active_at < cursor) OR (last_active_at = cursor AND id < cursorId)
    conditions.push(
      '(last_active_at < ? OR (last_active_at = ? AND id < ?))'
    )
    values.push(options.cursor, options.cursor, options.cursorId)
  }

  const sql = `SELECT * FROM sessions WHERE ${conditions.join(' AND ')}
    ORDER BY last_active_at DESC, id DESC LIMIT ?`
  values.push(requestLimit)

  const normalRows = db.prepare(sql).all(...values) as unknown as SessionRow[]
  const hasMore = normalRows.length > limit
  const slicedRows = hasMore ? normalRows.slice(0, limit) : normalRows

  // 合并：置顶在前 + 非置顶分页部分
  const allRows = [...pinnedRows, ...slicedRows]

  return {
    sessions: allRows.map((r) => toSession(r)),
    hasMore
  }
}
```

**关键设计说明**：

1. **置顶会话不参与分页**：`pinned = 1` 的会话始终全量返回，保证置顶项始终可见且不影响分页游标
2. **`limit + 1` 技巧**：无需额外 `COUNT(*)` 查询即可判断 `hasMore`
3. **复合游标**：`(last_active_at, id)` 防止同时间戳排序不稳定导致重复/遗漏
4. **`id DESC` 作为次级排序**：与消息列表的 `beforeId` 模式保持一致

### 4.4 `searchSessions` 实现

```typescript
searchSessions(query: string, limit = 50): Session[] {
  const rows = db.prepare(
    `SELECT * FROM sessions
     WHERE deleted_at IS NULL AND title LIKE ?
     ORDER BY last_active_at DESC
     LIMIT ?`
  ).all(`%${query}%`, limit) as unknown as SessionRow[]
  return rows.map((r) => toSession(r))
}
```

**说明**：标题搜索走后端 SQL `LIKE`，不依赖前端全量数据。分页模式下前端只有部分数据，纯前端 `filter` 无法搜索未加载的部分。

---

## 5. IPC 桥接层

### 修改 [db-service.ts](file:///Users/hupengfei/Documents/my-app/src/main/service/db-service.ts#L86)

```typescript
// 新增导入
import type { ListSessionsOptions, ListSessionsResult } from '../database'

// 导出类型
export type { ListSessionsOptions, ListSessionsResult }

// DbService 类中新增方法
listSessionsPaged(options?: ListSessionsOptions): ListSessionsResult {
  return db.listSessionsPaged(options)
}

searchSessions(query: string, limit?: number): Session[] {
  return db.searchSessions(query, limit)
}
```

**向后兼容**：`listSessions()` 保留不动，附件清理（`attachment.ts` L154）等内部调用不受影响。

---

## 6. 前端 Store 分页状态管理

### 修改 [useSessionStore.ts](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useSessionStore.ts)

#### 6.1 新增分页状态

```typescript
const PAGE_SIZE = 30

const sessions = ref<Session[]>([])
const currentSessionId = ref<string | null>(null)
const hasInitialized = ref(false)

// 新增分页状态
const hasMore = ref(false)
const loadingMore = ref(false)
/** 当前已加载的非置顶会话中最旧一条的游标 (lastActiveAt, id) */
const oldestCursor = ref<{ lastActiveAt: number; id: string } | null>(null)
/** 搜索关键词（空 = 非搜索模式） */
const searchQuery = ref('')
/** 搜索结果（后端 SQL LIKE 查询） */
const searchResults = ref<Session[]>([])
```

#### 6.2 修改 `load()` — 首次加载分页数据

```typescript
async function load(): Promise<void> {
  const result = await mainClient.db.listSessionsPaged({ limit: PAGE_SIZE })
  sessions.value = result.sessions
  hasMore.value = result.hasMore
  // 设置游标：取非置顶会话中最后一条
  updateOldestCursor()
}
```

#### 6.3 新增 `loadMore()` — 加载下一页

```typescript
async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value || !oldestCursor.value) return
  loadingMore.value = true
  try {
    const result = await mainClient.db.listSessionsPaged({
      limit: PAGE_SIZE,
      cursor: oldestCursor.value.lastActiveAt,
      cursorId: oldestCursor.value.id
    })
    sessions.value = [...sessions.value, ...result.sessions]
    hasMore.value = result.hasMore
    updateOldestCursor()
  } finally {
    loadingMore.value = false
  }
}
```

#### 6.4 新增 `searchSessions()` — 标题搜索

```typescript
async function searchSessions(query: string): Promise<void> {
  searchQuery.value = query
  if (!query.trim()) {
    searchResults.value = []
    return
  }
  searchResults.value = await mainClient.db.searchSessions(query.trim())
}
```

#### 6.5 新增 `updateOldestCursor()` — 更新游标

```typescript
function updateOldestCursor(): void {
  // 取非置顶会话中最后一条（排序最旧的）作为下一页游标
  const nonPinned = sessions.value.filter(s => !s.pinned).sort(
    (a, b) => a.lastActiveAt - b.lastActiveAt || (a.id > b.id ? 1 : -1)
  )
  const last = nonPinned[nonPinned.length - 1]
  oldestCursor.value = last
    ? { lastActiveAt: last.lastActiveAt, id: last.id }
    : null
}
```

#### 6.6 修改 `createSession()` — 插入头部

```typescript
async function createSession(params?: CreateSessionParams): Promise<Session> {
  const session = await mainClient.db.createSession(params)
  // 新建会话无 pinned，默认出现在非置顶列表最前面
  // 但不自动加入分页列表（用户可能不在第一页），
  // 通过 upsertSession 由 onSessionUpdate 推送处理
  return session
}
```

> **注意**：`createSession` 后新会话由 `useChatStore.send` 中 `upsertSession` 推送，或由 `agent-manager` 推送标题更新。但首次创建时用户一定在当前会话，侧边栏需要立即可见。**改为**：创建后仍然 `unshift`，同时 `updateOldestCursor()`。

```typescript
async function createSession(params?: CreateSessionParams): Promise<Session> {
  const session = await mainClient.db.createSession(params)
  sessions.value.unshift(session)
  return session
}
```

#### 6.7 修改 `deleteSession()` — 过滤删除

```typescript
async function deleteSession(id: string): Promise<void> {
  await mainClient.db.deleteSession(id)
  sessions.value = sessions.value.filter((s) => s.id !== id)
  updateOldestCursor()  // 新增：删除后更新游标
  useChatStore().removeSessionState(id)
  if (currentSessionId.value === id) {
    currentSessionId.value = null
    const next = sessions.value[0]
    if (next) await select(next.id)
    else await startNewChat()
  }
}
```

#### 6.8 修改 `renameSession` / `setPinned` / `setArchived` — 操作后更新游标

每个方法在 `findIndex` 替换后调用 `updateOldestCursor()`。以 `renameSession` 为例：

```typescript
async function renameSession(id: string, title: string): Promise<void> {
  const updated = await mainClient.db.updateSession(id, { title, touch: true })
  const idx = sessions.value.findIndex((s) => s.id === id)
  if (idx >= 0) sessions.value[idx] = updated
  updateOldestCursor()
}
```

**注意**：`touch: true` 会更新 `last_active_at`，使会话"变新"，游标也要随之更新。

#### 6.9 修改 `upsertSession()` — 推送更新处理

```typescript
async function upsertSession(session: Session): Promise<void> {
  const idx = sessions.value.findIndex((s) => s.id === session.id)
  if (idx >= 0) {
    sessions.value[idx] = session
  } else {
    // 新会话（如标题自动生成后首次出现），插入头部
    sessions.value.unshift(session)
  }
  updateOldestCursor()
}
```

#### 6.10 修改返回值

```typescript
return {
  sessions,
  currentSessionId,
  hasInitialized,
  hasMore,         // 新增
  loadingMore,     // 新增
  searchQuery,     // 新增
  searchResults,   // 新增
  load,
  loadMore,        // 新增
  createSession,
  startNewChat,
  select,
  renameSession,
  setPinned,
  setArchived,
  deleteSession,
  refreshSession,
  upsertSession,
  searchSessions   // 新增
}
```

---

## 7. 前端组件：无限滚动 + 搜索适配

### 修改 [SessionSidebar.vue](file:///Users/hupengfei/Documents/my-app/src/renderer/src/components/sidebar/SessionSidebar.vue)

#### 7.1 搜索改为后端查询

**现有代码**（L60-64）：前端 `filter` 全量数据

```typescript
const filteredSessions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sortedSessions.value
  return sortedSessions.value.filter((s) => s.title.toLowerCase().includes(q))
})
```

**改为**：使用 `sessionStore.searchResults`

```typescript
// 搜索防抖
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (q) => {
  clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (!trimmed) {
    sessionStore.searchSessions('')
    messageHits.value = []
    return
  }
  searchTimer = setTimeout(() => {
    sessionStore.searchSessions(trimmed)
  }, 200)
})

// 搜索模式下用后端结果
const filteredSessions = computed(() => {
  if (!isSearching.value) return sortedSessions.value
  return sessionStore.searchResults
})
```

#### 7.2 `sortedSessions` 简化

由于后端已按 `last_active_at DESC` 排序，且置顶在前，`sortedSessions` 可以简化为直接返回：

```typescript
const sortedSessions = computed(() => sessionStore.sessions)
```

**原因**：后端 `listSessionsPaged` 返回的顺序已经是 `pinned DESC, last_active_at DESC, id DESC`，前端不再需要二次排序。置顶项在前、时间倒序在后，与数据库排序一致。

#### 7.3 新增 `ref` 引用

```typescript
const sentinelRef = ref<HTMLElement | null>(null)
const scrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null)
```

#### 7.4 IntersectionObserver 哨兵

在 `onMounted` / `onUnmounted` 中设置：

```typescript
let sentinelObserver: IntersectionObserver | null = null

onMounted(() => {
  if (!sentinelRef.value) return
  const scrollEl = scrollbarRef.value?.$el?.querySelector('.n-scrollbar-container') as HTMLElement
  if (!scrollEl) return
  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some(e => e.isIntersecting)) {
        void sessionStore.loadMore()
      }
    },
    { root: scrollEl, rootMargin: '200px 0px 0px 0px' }
  )
  sentinelObserver.observe(sentinelRef.value)
})

onUnmounted(() => {
  sentinelObserver?.disconnect()
  clearTimeout(searchTimer)
})
```

#### 7.5 模板修改

```html
<NScrollbar ref="scrollbarRef" class="sidebar__list" :content-style="{ padding: '4px 6px 8px' }">
  <!-- 搜索模式：消息全文命中（保留不变） -->
  <div v-if="isSearching && messageHits.length > 0" class="sidebar__group">
    <!-- ... 保持不变 ... -->
  </div>

  <!-- 会话列表分组 -->
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

  <!-- 分页哨兵 -->
  <div ref="sentinelRef" v-if="!isSearching" class="sidebar__sentinel">
    <span v-if="sessionStore.loadingMore" class="sidebar__sentinel-tip">加载更多会话...</span>
  </div>

  <!-- 空状态 -->
  <div
    v-if="filteredSessions.length === 0 && (!isSearching || messageHits.length === 0)"
    class="sidebar__empty"
  >
    {{ isSearching ? (noSearchResult ? '未找到相关会话或消息' : '无匹配会话') : '无会话' }}
  </div>
</NScrollbar>
```

#### 7.6 新增样式

```css
.sidebar__sentinel {
  padding: 8px 0;
  text-align: center;
}
.sidebar__sentinel-tip {
  font-size: 12px;
  color: var(--text-3);
}
```

#### 7.7 消息搜索跳转适配

现有代码 [SessionSidebar.vue#L172](file:///Users/hupengfei/Documents/my-app/src/renderer/src/components/sidebar/SessionSidebar.vue#L172)：

```typescript
async function onSelectHit(hit: MessageSearchHit): Promise<void> {
  const session = sessionStore.sessions.find((s) => s.id === hit.sessionId)
  if (session) {
    await onSelect(session)
  } else {
    // 会话不在当前已加载列表中：直接 select（会触发 loadSession 加载消息）
    await sessionStore.select(hit.sessionId)
  }
  await chatStore.jumpToMessage(hit.sessionId, hit.messageId)
}
```

**无需修改**：分页后目标会话可能不在当前已加载列表中，但 `else` 分支已正确处理（直接 `select(hit.sessionId)`）。`select` 会设置 `currentSessionId` 并调用 `chatStore.loadSession`，不需要会话在侧边栏列表中。

---

## 8. 各功能影响分析与处理方案

### 8.1 启动时自动选择最近会话

**现状**：[ChatView.vue#L78](file:///Users/hupengfei/Documents/my-app/src/renderer/src/views/ChatView.vue#L78) `sessionStore.sessions[0]`

**影响**：第一页包含最近会话（按 `last_active_at DESC` 排序），`sessions[0]` 仍然是最近会话。

**处理**：无需修改。

### 8.2 创建会话后加入列表

**现状**：`createSession()` 中 `unshift`

**影响**：新会话排在最前面，与预期一致。

**处理**：保持 `unshift`，新会话创建后立即可见。

### 8.3 删除会话

**现状**：`filter` 移除 + 自动切换下一个

**影响**：已在 `deleteSession()` 中加入 `updateOldestCursor()`。

**处理**：见 6.7 节。

### 8.4 分叉创建会话

**现状**：[useChatStore.ts#L593](file:///Users/hupengfei/Documents/my-app/src/renderer/src/store/useChatStore.ts#L593) 直接 `sessionStore.sessions.unshift(session)`

**影响**：分叉创建的会话立即插入列表头部。

**处理**：保持不变。分叉后用户立即进入新会话，侧边栏需要立即显示。

### 8.5 主进程推送 `onSessionUpdate`

**现状**：[agent-event-service.ts#L142-145](file:///Users/hupengfei/Documents/my-app/src/renderer/src/service/agent-event-service.ts#L142-L145) 调用 `upsertSession`

**影响**：推送的会话可能不在当前已加载列表中（如标题自动生成在后台完成）。

**处理**：`upsertSession` 已处理（存在则替换，不存在则 `unshift`）。新增 `updateOldestCursor()` 调用。

### 8.6 孤儿附件清理

**现状**：[attachment.ts#L154](file:///Users/hupengfei/Documents/my-app/src/main/agent/attachment.ts#L154) 调用 `db.listSessions()`

**影响**：不受影响。`db.listSessions()` 保留全量查询接口。

**处理**：无需修改。

### 8.7 `setPinned` 置顶操作

**现状**：更新 `pinned` 字段

**影响**：置顶会话从非置顶区移到置顶区。需要：
1. 在内存列表中替换对应项
2. 更新游标（原置顶项可能影响游标位置）

**处理**：`setPinned` 已在 6.8 节中加入 `updateOldestCursor()`。

### 8.8 `setArchived` 归档操作

**处理**：同置顶操作，加入 `updateOldestCursor()`。

### 8.9 `refreshSession` 刷新单个会话

**处理**：加入 `updateOldestCursor()`。

---

## 9. 数据库变更

### 现有索引

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at);
```

### 新增索引（可选，提升复合游标性能）

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_cursor ON sessions(pinned, last_active_at DESC, id DESC);
```

**评估**：现有 `idx_sessions_active` 索引在大多数场景下足够（会话数量级在千以内）。复合索引仅在会话数量极大（万级）时有明显提升。建议先不加，观察实际性能后再决定。

### 标题搜索索引（可选）

```sql
CREATE INDEX IF NOT EXISTS idx_sessions_title ON sessions(title);
```

**评估**：`LIKE '%keyword%'` 无法走 B-tree 索引，但 `sessions` 表数据量小，全表扫描也很快。暂不加。

---

## 10. 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/main/database/types/session.ts` | 新增类型 | `ListSessionsOptions`、`ListSessionsResult` |
| `src/main/database/sessions.ts` | 新增方法 | `listSessionsPaged()`、`searchSessions()` |
| `src/main/database/index.ts` | 无需修改 | `db` 门面自动包含新方法 |
| `src/main/service/db-service.ts` | 新增方法 | `listSessionsPaged()`、`searchSessions()` + 类型导出 |
| `src/renderer/src/store/useSessionStore.ts` | 重构 | 分页状态管理 + `loadMore()` + `searchSessions()` + `updateOldestCursor()` |
| `src/renderer/src/components/sidebar/SessionSidebar.vue` | 重构 | IntersectionObserver 哨兵 + 搜索后端化 + 移除前端排序 |
| `src/renderer/src/views/ChatView.vue` | 无需修改 | `sessions[0]` 仍可用 |
| `src/renderer/src/store/useChatStore.ts` | 无需修改 | `forkFromMessage` 的 `unshift` 仍可用 |
| `src/main/agent/attachment.ts` | 无需修改 | 使用 `listSessions()` 全量接口 |

---

## 11. 测试计划

### 11.1 单元测试

| 用例 | 预期 |
|------|------|
| `listSessionsPaged()` 无参数 | 返回前 30 条 + hasMore 判断正确 |
| `listSessionsPaged({ limit: 5 })` | 返回 5 条（含置顶） |
| `listSessionsPaged({ cursor, cursorId })` | 返回下一页数据 |
| `listSessionsPaged()` 最后一页 | `hasMore = false` |
| 置顶会话始终返回 | 滚动多页后置顶会话仍在第一页 |
| `searchSessions('关键词')` | 返回标题匹配的会话 |
| `searchSessions('')` | 返回空数组 |

### 11.2 集成测试

| 场景 | 预期 |
|------|------|
| 创建新会话 | 侧边栏立即显示在顶部 |
| 删除当前会话 | 自动切换下一个，侧边栏正确移除 |
| 重命名会话 | 侧边栏立即反映标题变更 |
| 置顶/取消置顶 | 会话在置顶组/日期组间正确移动 |
| 发送消息后 touch | 会话移到列表最前（第一页） |
| 主进程推送标题更新 | 侧边栏立即更新标题 |
| 搜索关键词 | 侧边栏显示后端搜索结果 |
| 消息搜索跳转到未加载的会话 | 正确切换并加载消息窗口 |
| 滚动到底部 | 自动加载更多会话 |
| 快速连续滚动 | 不重复加载（loadingMore 锁） |

### 11.3 边界测试

| 场景 | 预期 |
|------|------|
| 0 个会话 | 显示"无会话"空状态 |
| 1-29 个会话 | 不显示"加载更多"哨兵 |
| 恰好 30 个会话 | 显示哨兵，滚动后加载 |
| 搜索模式下不触发无限滚动 | 搜索结果不分页 |
| 加载期间切换会话 | 无异常，游标正确更新 |
