import { Type, type TSchema } from '@earendil-works/pi-ai'

/**
 * JSON Schema（MCP 工具 inputSchema）→ TypeBox 类型（AgentTool.parameters）。
 *
 * pi-ai 的工具参数必须是 TypeBox schema（内部经 Symbol.for("TypeBox.Kind") 校验），
 * 而 MCP 协议给的是标准 JSON Schema，二者需要转换。这里覆盖 MCP server 常用的
 * 子集（object/array/string/number/integer/boolean/null/enum/anyOf），
 * 无法映射的节点一律退化为 Type.Any()（参数原样透传，不做强校验）。
 */

/** 递归转换单个 JSON Schema 节点。 */
export function jsonSchemaToType(schema: unknown): TSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return Type.Any()
  const s = schema as Record<string, unknown>

  // 枚举：字面量联合（仅支持原始值）
  if (Array.isArray(s.enum)) {
    const literals = s.enum.filter(
      (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ) as (string | number | boolean)[]
    if (literals.length === 1) return Type.Literal(literals[0])
    if (literals.length > 1) {
      const union = literals.map((v) => Type.Literal(v)) as unknown as [
        TSchema,
        TSchema,
        ...TSchema[]
      ]
      return Type.Union(union)
    }
  }

  // anyOf / oneOf：联合（含 {type:'null'} 的即可空类型）
  const variants = s.anyOf ?? s.oneOf
  if (Array.isArray(variants) && variants.length > 0) {
    const items = variants.map((v) => jsonSchemaToType(v))
    if (items.length === 1) return items[0]
    return Type.Union(items as [TSchema, TSchema, ...TSchema[]])
  }

  switch (s.type) {
    case 'string':
      return Type.String(descriptionOption(s))
    case 'number':
      return Type.Number(descriptionOption(s))
    case 'integer':
      return Type.Integer(descriptionOption(s))
    case 'boolean':
      return Type.Boolean(descriptionOption(s))
    case 'null':
      return Type.Null()
    case 'array': {
      const items = s.items !== undefined ? jsonSchemaToType(s.items) : Type.Any()
      return Type.Array(items)
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
      const fields: Record<string, TSchema> = {}
      for (const [key, value] of Object.entries(props)) {
        const t = jsonSchemaToType(value)
        fields[key] = required.has(key) ? t : Type.Optional(t)
      }
      return Type.Object(fields, descriptionOption(s))
    }
    default:
      return Type.Any()
  }
}

/** 从 JSON Schema 提取 description 作为 TypeBox 选项；无描述返回 undefined。 */
function descriptionOption(s: Record<string, unknown>): { description: string } | undefined {
  const desc = s.description
  return typeof desc === 'string' && desc.trim().length > 0 ? { description: desc } : undefined
}
