/** 设置项（JSON 值） */
export interface Setting {
  key: string
  /** JSON 解析后的值 */
  value: unknown
}

/** 数据库行类型（内部）：settings 表 */
export interface SettingRow {
  key: string
  value: string
}
