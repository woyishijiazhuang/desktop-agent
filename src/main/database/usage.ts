import type { DatabaseSync } from 'node:sqlite'
import type { UsageDayStat, UsageRangeDays, UsageStats, RecordUsageParams } from './types'
import { localDayKey } from './utils'

/** 用量统计域 API（index.ts 组装进 db 门面）。 */
export interface UsageApi {
  /** 记录一次 LLM 调用用量（对话/标题生成/压缩摘要），供用量统计聚合。 */
  recordUsage(params: RecordUsageParams): void
  getUsageStats(rangeDays: UsageRangeDays): UsageStats
}

/** 用量统计。 */
export function createUsageApi(db: DatabaseSync): UsageApi {
  return {
    recordUsage(params: RecordUsageParams): void {
      db.prepare(
        `INSERT INTO usage_logs
          (session_id, kind, provider, model, prompt_tokens, completion_tokens, cost, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        params.sessionId,
        params.kind,
        params.provider ?? null,
        params.model ?? null,
        params.promptTokens,
        params.completionTokens,
        params.cost,
        params.timestamp
      )
    },

    /**
     * 用量/Token 统计：汇总 + 按天趋势 + 按模型分布。
     * 数据源为 usage_logs（每次 LLM 调用的唯一记录，含对话/标题生成/压缩摘要）；
     * 排除回收站（软删除）会话。messages 仅用于「消息数」数量展示，与 token 无关。
     */
    getUsageStats(rangeDays: UsageRangeDays): UsageStats {
      const rangeStart = rangeDays === null ? null : Date.now() - rangeDays * 24 * 60 * 60 * 1000
      const args: number[] = rangeStart === null ? [] : [rangeStart]
      const from =
        'FROM usage_logs u JOIN sessions s ON s.id = u.session_id AND s.deleted_at IS NULL'
      const where = rangeStart === null ? '' : 'WHERE u.timestamp >= ?'

      const sumExpr = (col: string): string => `SUM(COALESCE(u.${col}, 0))`
      const totalExpr = `${sumExpr('prompt_tokens')} + ${sumExpr('completion_tokens')}`

      const totalRow = db
        .prepare(
          `SELECT COUNT(DISTINCT u.session_id) AS sessions,
                  COUNT(*) AS calls,
                  ${sumExpr('prompt_tokens')} AS prompt_tokens,
                  ${sumExpr('completion_tokens')} AS completion_tokens,
                  ${sumExpr('cost')} AS cost
           ${from} ${where}`
        )
        .get(...args) as unknown as {
        sessions: number
        calls: number
        prompt_tokens: number
        completion_tokens: number
        cost: number
      }

      // 消息数（含用户/工具等非计费消息）：仅数量展示，仍按 messages 表统计。
      const messageCountRow = db
        .prepare(
          `SELECT COUNT(*) AS messages
           FROM messages m JOIN sessions s ON s.id = m.session_id AND s.deleted_at IS NULL
           ${rangeStart === null ? '' : 'WHERE m.timestamp >= ?'}`
        )
        .get(...args) as unknown as { messages: number }

      const dayRows = db
        .prepare(
          `SELECT date(u.timestamp / 1000, 'unixepoch', 'localtime') AS day,
                  COUNT(*) AS calls,
                  ${sumExpr('prompt_tokens')} AS prompt_tokens,
                  ${sumExpr('completion_tokens')} AS completion_tokens,
                  ${sumExpr('cost')} AS cost
           ${from} ${where}
           GROUP BY day ORDER BY day ASC`
        )
        .all(...args) as unknown as {
        day: string
        calls: number
        prompt_tokens: number
        completion_tokens: number
        cost: number
      }[]

      const modelRows = db
        .prepare(
          `SELECT COALESCE(u.provider, '') AS provider,
                  COALESCE(u.model, '未知模型') AS model,
                  COUNT(*) AS calls,
                  ${sumExpr('prompt_tokens')} AS prompt_tokens,
                  ${sumExpr('completion_tokens')} AS completion_tokens,
                  ${sumExpr('cost')} AS cost
           ${from} ${where}
           GROUP BY u.provider, u.model
           ORDER BY (${totalExpr}) DESC`
        )
        .all(...args) as unknown as {
        provider: string
        model: string
        calls: number
        prompt_tokens: number
        completion_tokens: number
        cost: number
      }[]

      // 按天补 0：从区间起点所在日（或数据最早日）到「今天」，保证趋势图连续。
      const todayKey = localDayKey(new Date())
      const earliestKey =
        dayRows.length > 0
          ? dayRows[0].day
          : rangeStart !== null
            ? localDayKey(new Date(rangeStart))
            : todayKey
      const dayMap = new Map(dayRows.map((r) => [r.day, r]))
      const byDay: UsageDayStat[] = []
      const cursor = new Date(`${earliestKey}T00:00:00`)
      while (localDayKey(cursor) <= todayKey) {
        const key = localDayKey(cursor)
        const row = dayMap.get(key)
        const promptTokens = row?.prompt_tokens ?? 0
        const completionTokens = row?.completion_tokens ?? 0
        byDay.push({
          day: key,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          cost: row?.cost ?? 0,
          messageCount: row?.calls ?? 0
        })
        cursor.setDate(cursor.getDate() + 1)
      }
      // range=all 且历史跨度过长时截断到最近 732 天（2 年），避免图表数据爆炸。
      if (byDay.length > 732) byDay.splice(0, byDay.length - 732)

      return {
        rangeStart,
        sessions: totalRow.sessions,
        messages: messageCountRow.messages,
        calls: totalRow.calls,
        promptTokens: totalRow.prompt_tokens,
        completionTokens: totalRow.completion_tokens,
        totalTokens: totalRow.prompt_tokens + totalRow.completion_tokens,
        cost: totalRow.cost,
        byDay,
        byModel: modelRows.map((r) => ({
          provider: r.provider,
          model: r.model,
          promptTokens: r.prompt_tokens,
          completionTokens: r.completion_tokens,
          totalTokens: r.prompt_tokens + r.completion_tokens,
          cost: r.cost,
          messageCount: r.calls
        }))
      }
    }
  }
}
