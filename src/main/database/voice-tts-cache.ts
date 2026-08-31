import type { DatabaseSync } from 'node:sqlite'

/** 语音工具提示语 TTS 缓存行（audio 为 data URL，主进程直接合成后落库）。 */
export interface VoiceTtsCacheRow {
  phrase: string
  voice: string
  style: string
  variant: number
  audio: string
}

/** 语音工具提示语 TTS 缓存域 API（index.ts 组装进 db 门面）。 */
export interface VoiceTtsCacheApi {
  listVoiceTtsCache(phrase: string, voice: string, style: string): VoiceTtsCacheRow[]
  insertVoiceTtsCache(row: VoiceTtsCacheRow): void
  clearVoiceTtsCache(): void
}

/**
 * 语音工具提示语 TTS 缓存读写。缓存键 = (phrase, voice, style, variant)，
 * 由 idx_voice_tts_cache_key 唯一约束支撑 upsert（同键重复合成时直接覆盖）。
 * 音色/风格指令变更后键自然失配，settings 侧再调 clearVoiceTtsCache 整体清空旧键。
 */
export function createVoiceTtsCacheApi(db: DatabaseSync): VoiceTtsCacheApi {
  return {
    listVoiceTtsCache(phrase, voice, style) {
      return db
        .prepare(
          'SELECT phrase, voice, style, variant, audio FROM voice_tts_cache WHERE phrase = ? AND voice = ? AND style = ?'
        )
        .all(phrase, voice, style) as unknown as VoiceTtsCacheRow[]
    },

    insertVoiceTtsCache(row) {
      db.prepare(
        `INSERT INTO voice_tts_cache (phrase, voice, style, variant, audio, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(phrase, voice, style, variant)
         DO UPDATE SET audio = excluded.audio, created_at = excluded.created_at`
      ).run(row.phrase, row.voice, row.style, row.variant, row.audio, Date.now())
    },

    clearVoiceTtsCache() {
      db.prepare('DELETE FROM voice_tts_cache').run()
    }
  }
}
