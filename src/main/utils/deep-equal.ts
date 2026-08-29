/**
 * 深比较（对象键序无关；数组按序）。
 */
export function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => isDeepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>
    const rb = b as Record<string, unknown>
    const ka = Object.keys(ra).sort()
    const kb = Object.keys(rb).sort()
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && isDeepEqual(ra[k], rb[k]))
  }
  return false
}
