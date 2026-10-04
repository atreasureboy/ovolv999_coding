const CONTROL_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
}

export function formatApprovalDisplay(value: string): string {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0)!
    if (point > 0x1f && (point < 0x7f || point > 0x9f) && point !== 0x2028 && point !== 0x2029 && !/\p{Cf}/u.test(character)) return character
    return CONTROL_ESCAPES[character] ?? (point <= 0xffff ? `\\u${point.toString(16).padStart(4, '0')}` : `\\u{${point.toString(16)}}`)
  }).join('')
}
