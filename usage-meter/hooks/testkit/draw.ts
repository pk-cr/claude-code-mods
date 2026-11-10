// A small text renderer for the trees the mod draws (Box, Text, Button), laid out
// the way the terminal lays them out for the props the mod uses: row and column
// boxes, fixed widths, gaps, wrapping rows, padding and round borders. The tests
// read a mounted drawing with it, and the previews print one. The engine never
// loads this file: register.tsx does not import it.

type El = { type: string; props: Record<string, unknown>; children: Item[] }
type Item = El | string

function asItems(value: unknown): Item[] {
  if (Array.isArray(value)) return value.flatMap(asItems)
  if (typeof value === 'string') return [value]
  if (typeof value === 'number') return [String(value)]
  if (value === null || value === undefined || typeof value === 'boolean') return []
  const node = value as { type?: unknown; props?: unknown; children?: unknown }
  const props = (node.props ?? {}) as Record<string, unknown>

  return [{ type: String(node.type), props, children: asItems(node.children ?? props['children'] ?? []) }]
}

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const textOf = (item: Item): string => (typeof item === 'string' ? item : item.children.map(textOf).join(''))

const pad = (text: string, width: number): string => (text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length))

const isBox = (item: Item): item is El => typeof item !== 'string' && item.type === 'Box'

function frame(el: El): { border: number; padX: number } {
  return { border: el.props['borderStyle'] === undefined ? 0 : 1, padX: num(el.props['paddingX'], num(el.props['padding'])) }
}

function natural(item: Item): number {
  if (typeof item === 'string') return item.length
  if (item.type === 'Text') return textOf(item).length
  if (item.type === 'Button') return String(item.props['label'] ?? '').length + 4
  if (item.props['width'] !== undefined) return num(item.props['width'])
  const { border, padX } = frame(item)
  const sizes = item.children.map(natural)
  const inner =
    (item.props['flexDirection'] ?? 'row') === 'column'
      ? Math.max(0, ...sizes)
      : sizes.reduce((sum, size) => sum + size, 0) + num(item.props['columnGap'], num(item.props['gap'])) * Math.max(0, sizes.length - 1)

  return inner + 2 * (border + padX)
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width)
    const at = cut > 0 ? cut : width
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^ /, '')
  }
  out.push(rest)

  return out
}

function leaf(item: Item, width: number): string[] {
  if (typeof item === 'string') return wrapText(item, width).map(part => pad(part, width))
  const text = item.type === 'Button' ? `[ ${String(item.props['label'] ?? '')} ]` : textOf(item)
  if (item.type === 'Text' && String(item.props['wrap'] ?? 'wrap').startsWith('truncate') && text.length > width) {
    return [pad(`${text.slice(0, Math.max(0, width - 1))}…`, width)]
  }

  return wrapText(text, width).map(part => pad(part, width))
}

function rowOf(items: readonly Item[], inner: number, gap: number, justify: string, height?: number): string[] {
  const bases = items.map(item => (isBox(item) && item.props['width'] !== undefined ? num(item.props['width']) : natural(item)))
  const widths = [...bases]
  let free = inner - widths.reduce((sum, size) => sum + size, 0) - gap * Math.max(0, items.length - 1)
  const grows = items.map(item => (isBox(item) ? num(item.props['flexGrow']) : 0))
  const growSum = grows.reduce((sum, grow) => sum + grow, 0)
  if (free > 0 && growSum > 0) {
    items.forEach((_, index) => {
      widths[index] = (widths[index] ?? 0) + Math.floor((free * (grows[index] ?? 0)) / growSum)
    })
    free = 0
  }
  while (free < 0) {
    let widest = -1
    items.forEach((item, index) => {
      const canShrink = !(isBox(item) && item.props['flexShrink'] === 0)
      if (canShrink && (widest < 0 || (widths[index] ?? 0) > (widths[widest] ?? 0))) widest = index
    })
    if (widest < 0 || (widths[widest] ?? 0) <= 1) break
    widths[widest] = (widths[widest] ?? 0) - 1
    free += 1
  }
  let drawn = items.map((item, index) => layout(item, widths[index] ?? 0))
  const tallest = Math.max(height ?? 0, ...drawn.map(lines => lines.length))
  // Boxes stretch to the row's height, as Ink's default alignItems does.
  drawn = drawn.map((lines, index) => {
    const item = items[index]
    if (item !== undefined && isBox(item) && lines.length < tallest) return layout(item, widths[index] ?? 0, tallest)

    return lines
  })
  const lead = free > 0 && justify === 'flex-end' ? free : 0
  const out: string[] = []
  for (let lineIndex = 0; lineIndex < tallest; lineIndex += 1) {
    const parts = drawn.map((lines, index) => lines[lineIndex] ?? ' '.repeat(widths[index] ?? 0))
    out.push(pad(' '.repeat(lead) + parts.join(' '.repeat(gap)), inner))
  }

  return out
}

function layout(item: Item, width: number, height?: number): string[] {
  if (!isBox(item)) return leaf(item, width)
  const { border, padX } = frame(item)
  const inner = Math.max(0, width - 2 * (border + padX))
  const direction = item.props['flexDirection'] ?? 'row'
  const kids = item.children
  let body: string[] = []
  if (direction === 'column') {
    const rowGap = num(item.props['rowGap'], num(item.props['gap']))
    kids.forEach((kid, index) => {
      if (index > 0) for (let n = 0; n < rowGap; n += 1) body.push(' '.repeat(inner))
      const kidWidth = isBox(kid) && kid.props['width'] !== undefined ? num(kid.props['width']) : inner
      body.push(...layout(kid, kidWidth).map(each => pad(each, inner)))
    })
  } else {
    const gap = num(item.props['columnGap'], num(item.props['gap']))
    const justify = String(item.props['justifyContent'] ?? 'flex-start')
    if (item.props['flexWrap'] === 'wrap') {
      const lines: Item[][] = [[]]
      let used = 0
      for (const kid of kids) {
        const size = isBox(kid) && kid.props['width'] !== undefined ? num(kid.props['width']) : natural(kid)
        const current = lines[lines.length - 1] ?? []
        if (current.length > 0 && used + gap + size > inner) {
          lines.push([kid])
          used = size
        } else {
          current.push(kid)
          used += (current.length > 1 ? gap : 0) + size
        }
      }
      body = lines.flatMap(each => rowOf(each, inner, gap, justify))
    } else {
      body = rowOf(kids, inner, gap, justify, height === undefined ? undefined : Math.max(0, height - 2 * border))
    }
  }
  const content = height === undefined ? body : [...body, ...Array.from({ length: Math.max(0, height - 2 * border - body.length) }, () => ' '.repeat(inner))]
  const padded = content.map(each => `${' '.repeat(padX)}${pad(each, inner)}${' '.repeat(padX)}`)
  if (border === 0) return padded

  return [`╭${'─'.repeat(width - 2)}╮`, ...padded.map(each => `│${each}│`), `╰${'─'.repeat(width - 2)}╯`]
}

/** A drawn tree as lines `width` cells wide, trailing spaces cut. */
export function drawText(tree: unknown, width: number): string[] {
  return asItems(tree).flatMap(item => layout(item, width)).map(each => each.trimEnd())
}
