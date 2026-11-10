// The price table. Dollars per million tokens.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read on
// PRICES_AS_OF. Check that page again when a model ships. The "Check" row of the
// pane compares the estimate with the engine's own cost total, so a wrong row shows.
//
// Cache reads are not one fixed fraction of the input price: 0.1x for most models,
// 0.05x on Opus 5.5, 0.025x on Fable 5.1. So each row keeps its own five rates.

export const PRICES_AS_OF = '2026-10-07'

export type Price = {
  /** Uncached input. */
  in: number
  /** Cache write, 5-minute lifetime (1.25x input). */
  w5: number
  /** Cache write, 1-hour lifetime (2x input). */
  w1: number
  /** Cache read. */
  r: number
  /** Output. */
  out: number
}

export type PriceRow = Price & {
  /** The model id without a date suffix. */
  id: string
  /** A caveat the pane shows next to the model. */
  note?: string
}

const OPUS_5: Price = { in: 5, w5: 6.25, w1: 10, r: 0.5, out: 25 }
const SONNET_5: Price = { in: 2, w5: 2.5, w1: 4, r: 0.2, out: 10 }
const SONNET_4: Price = { in: 3, w5: 3.75, w1: 6, r: 0.3, out: 15 }
const FABLE: Price = { in: 10, w5: 12.5, w1: 20, r: 1, out: 50 }
const FABLE_5_1: Price = { in: 10, w5: 12.5, w1: 20, r: 0.25, out: 50 }

export const PRICES: readonly PriceRow[] = [
  { id: 'claude-fable-5-1', ...FABLE_5_1 },
  { id: 'claude-mythos-5-1', ...FABLE_5_1 },
  { id: 'claude-fable-5', ...FABLE },
  { id: 'claude-mythos-5', ...FABLE },
  { id: 'claude-opus-5-5', in: 4, w5: 5, w1: 8, r: 0.2, out: 20 },
  { id: 'claude-opus-5', ...OPUS_5 },
  { id: 'claude-opus-4-8', ...OPUS_5 },
  { id: 'claude-opus-4-7', ...OPUS_5 },
  { id: 'claude-opus-4-6', ...OPUS_5 },
  { id: 'claude-opus-4-5', ...OPUS_5 },
  {
    id: 'claude-sonnet-5-5',
    ...SONNET_5,
    note: 'cache read is $0.20 in the price table and $0.10 in the page text; the table is used',
  },
  { id: 'claude-sonnet-5', ...SONNET_5 },
  { id: 'claude-sonnet-4-6', ...SONNET_4 },
  { id: 'claude-sonnet-4-5', ...SONNET_4 },
  {
    id: 'claude-haiku-5-5',
    in: 0.1,
    w5: 0.125,
    w1: 0.2,
    r: 0.01,
    out: 0.5,
    note: 'prompts over 100k tokens cost more; the low tier is used',
  },
  { id: 'claude-haiku-4-5', in: 1, w5: 1.25, w1: 2, r: 0.1, out: 5 },
]

/**
 * The id a model groups under: lower case, no `[1m]`-style suffix, no `-YYYYMMDD` date.
 * `claude-haiku-4-5-20251001` and `claude-haiku-4-5` are one model.
 */
export function modelKey(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
}

/** The row for a model id, or undefined when the table does not know it. An unknown id is never guessed. */
export function priceFor(model: string): PriceRow | undefined {
  const key = modelKey(model)

  return PRICES.find(row => row.id === key)
}

/** Days from `PRICES_AS_OF` to `now` (a time in ms). */
export function priceAgeDays(now: number): number {
  const asOf = Date.parse(`${PRICES_AS_OF}T00:00:00Z`)

  return Math.floor((now - asOf) / 86_400_000)
}
