/**
 * Typed views over the backend's aggregate output.
 *
 * Aggregates arrive as `Record<string, unknown>` on purpose: aggregators are
 * added without the frontend knowing, and the LLM-written ones are only as
 * well-shaped as the model's last response. Two generations of shapes are in
 * the wild — the old core service (`duration`, `key_points`, `observations`)
 * and VIDRA (`duration_s`, `notable`, `mentions`) — so every reader accepts
 * both, coerces what it needs, and drops what it cannot use. Anything with no
 * reader still renders on the Record tab through `JsonView`.
 */

import type { ChunkOut } from '@/lib/core/types'

export const asRecord = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}

export const asArray = (value: unknown): any[] => (Array.isArray(value) ? value : [])

export const num = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const str = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

/** The first of several keys that holds a number, for fields renamed between backends. */
const firstNum = (record: Record<string, any>, keys: string[], fallback = 0) => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return num(record[key], fallback)
  }
  return fallback
}

/**
 * A string that is really JSON, parsed; anything else returned as-is.
 *
 * Older builds flattened the vision model's `{object, appearance, context}`
 * records to `json.dumps(...)` strings, and LLM aggregators occasionally do the
 * same, so any field may hold an object in disguise.
 */
export function parseLoose(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!/^[[{]/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/** A label for anything — a JSON-ish string or record reduced to its best name. */
export function labelOf(value: unknown): string {
  const parsed = parseLoose(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    return (
      str(record.object) ||
      str(record.name) ||
      str(record.label) ||
      str(record.text) ||
      str(record.description) ||
      str(value)
    )
  }
  return str(parsed)
}

/** `road vehicles` → `Road vehicles`. Model output is inconsistently cased. */
export const sentenceCase = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : value

export interface DetectionRow {
  object: string
  appearance: string
  context: string
}

/** Object detections, whether the backend sent records, names or JSON strings. */
export function readDetections(detections: unknown, objects: unknown): DetectionRow[] {
  const source = asArray(detections).length ? asArray(detections) : asArray(objects)
  return source
    .map((item) => {
      let record = asRecord(parseLoose(item))
      // `{object: '{"object": …}'}` — the record wrapped around a JSON string.
      const inner = asRecord(parseLoose(record.object))
      if (Object.keys(inner).length) record = { ...record, ...inner }
      if (!Object.keys(record).length) record = { object: item }
      return {
        object: labelOf(record.object ?? record.name ?? record.label),
        appearance: str(record.appearance) || str(record.description),
        context: str(record.context),
      }
    })
    .filter((row) => row.object)
}

/** `[name, count]` pairs or `{name, count}` rows — every "most common" list. */
export function counted(value: unknown): { name: string; count: number }[] {
  return asArray(value)
    .map((entry) =>
      Array.isArray(entry)
        ? { name: labelOf(entry[0]), count: num(entry[1]) }
        : { name: labelOf(asRecord(entry).name), count: num(asRecord(entry).count) }
    )
    .filter((entry) => entry.name)
}

/** Chunk id → its span, so anything that names chunks can be placed in time. */
export type ChunkSpans = Map<number, { start: number; end: number }>

export const chunkSpans = (chunks: ChunkOut[]): ChunkSpans =>
  new Map(chunks.map((chunk) => [chunk.chunk_id, { start: chunk.start, end: chunk.end }]))

/** Contiguous chunk ids merged into spans, for presence strips. */
export function spansOf(ids: number[], spans: ChunkSpans): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = []
  for (const id of [...ids].sort((a, b) => a - b)) {
    const span = spans.get(id)
    if (!span) continue
    const last = merged.at(-1)
    if (last && span.start - last.end < 0.5) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

// ------------------------------------------------------------------ summary

export interface SummarySection {
  summary: string
  start: number
  end: number
  chunk_ids: number[]
}

export interface SummaryTier {
  level: number
  section_count: number
  sections: SummarySection[]
}

export interface SummaryAggregate {
  summary: string
  setting: string
  key_points: string[]
  topics: string[]
  tiers: SummaryTier[]
  based_on: string[]
  word_count: number
  chunks_read: number
}

export function readSummary(value: unknown): SummaryAggregate | null {
  const raw = asRecord(value)
  const levels = asArray(raw.tiers).length ? asArray(raw.tiers) : asArray(raw.layers)
  if (!raw.summary && !levels.length) return null

  return {
    summary: str(raw.summary),
    setting: str(raw.setting),
    key_points: [...asArray(raw.key_points), ...asArray(raw.notable)].map(labelOf).filter(Boolean),
    topics: asArray(raw.topics).map(labelOf).filter(Boolean),
    based_on: asArray(raw.based_on).map(str),
    word_count: num(raw.word_count),
    chunks_read: num(raw.chunks_read),
    tiers: levels.map((tier, index) => {
      const entry = asRecord(tier)
      const sections = asArray(entry.sections).length
        ? asArray(entry.sections)
        : asArray(entry.parts)
      return {
        level: num(entry.level, index),
        section_count: num(entry.section_count, sections.length),
        sections: sections.map((section) => {
          const s = asRecord(section)
          return {
            summary: str(s.summary),
            start: firstNum(s, ['start', 'start_ts']),
            end: firstNum(s, ['end', 'end_ts']),
            chunk_ids: asArray(s.chunk_ids).map((id) => num(id)),
          }
        }),
      }
    }),
  }
}

// ------------------------------------------------------------------ stats

export interface StatsAggregate {
  duration: number
  chunks: number
  chunk_span: { min: number; median: number; max: number } | null
  policy: string
  frames_sampled: number
  by_sampler: { name: string; count: number }[]
  words: number
  chunks_with_speech: number
  words_per_minute: number
  /** Old core shape only. */
  people: Record<string, any>
  objects: Record<string, any>
  speech: Record<string, any>
}

export function readStats(value: unknown): StatsAggregate | null {
  const raw = asRecord(value)
  if (!Object.keys(raw).length) return null
  const span = asRecord(raw.chunk_s)
  const speech = asRecord(raw.speech)

  return {
    duration: firstNum(raw, ['duration_s', 'duration']),
    chunks: num(raw.chunks),
    chunk_span: Object.keys(span).length
      ? { min: num(span.min), median: num(span.median), max: num(span.max) }
      : null,
    policy: str(raw.policy),
    frames_sampled: num(raw.frames_sampled),
    by_sampler: Object.entries(asRecord(raw.descriptions_by_sampler)).map(([name, count]) => ({
      name,
      count: num(count),
    })),
    words: firstNum(raw, ['words'], num(speech.words)),
    chunks_with_speech: firstNum(raw, ['chunks_with_speech'], num(speech.chunks_with_speech)),
    words_per_minute: num(raw.words_per_minute),
    people: asRecord(raw.people),
    objects: asRecord(raw.objects),
    speech,
  }
}

// ------------------------------------------------------------------ coverage

export interface CoverageAggregate {
  both: number
  picture_only: number
  sound_only: number
  neither: number
}

export function readCoverage(value: unknown): CoverageAggregate | null {
  const raw = asRecord(value)
  if (!Object.keys(raw).length) return null
  return {
    both: num(raw.both),
    picture_only: num(raw.picture_only),
    sound_only: num(raw.sound_only),
    neither: num(raw.neither),
  }
}

// ------------------------------------------------------------------ chapters & events

export interface ChapterRow {
  title: string
  summary: string
  start: number
  end: number
  chunk_ids: number[]
}

export function readChapters(value: unknown): ChapterRow[] {
  return asArray(asRecord(value).chapters)
    .map((row) => {
      const chapter = asRecord(row)
      return {
        title: str(chapter.title) || 'Untitled',
        summary: str(chapter.summary),
        start: firstNum(chapter, ['start', 'start_ts']),
        end: firstNum(chapter, ['end', 'end_ts']),
        chunk_ids: asArray(chapter.chunk_ids).map((id) => num(id)),
      }
    })
    .filter((chapter) => chapter.end > chapter.start)
    .sort((a, b) => a.start - b.start)
}

export interface EventRow {
  event: string
  actor: string
  category: string
  chunk_id: number
  start: number
  end: number
}

export function readEvents(value: unknown): EventRow[] {
  return asArray(asRecord(value).events)
    .map((row) => {
      const event = asRecord(row)
      return {
        event: str(event.event) || str(event.what) || str(event.description),
        actor: str(event.actor),
        category: str(event.category) || str(event.kind),
        chunk_id: num(event.chunk_id, -1),
        start: firstNum(event, ['start', 'start_ts']),
        end: firstNum(event, ['end', 'end_ts']),
      }
    })
    .filter((event) => event.event)
    .sort((a, b) => a.start - b.start)
}

// ------------------------------------------------------------------ named entities

export interface NamedEntity {
  text: string
  label: string
  mentions: number
  chunk_ids: number[]
}

/** Named entities grouped by label, most-mentioned first. */
export function readNamedEntities(value: unknown): { label: string; entities: NamedEntity[] }[] {
  const raw = asRecord(value)
  const rows: NamedEntity[] = asArray(raw.entities)
    .map((row) => {
      const entity = asRecord(row)
      return {
        text: str(entity.text),
        label: str(entity.label) || 'other',
        mentions: num(entity.mentions, 1),
        chunk_ids: asArray(entity.chunk_ids).map((id) => num(id)),
      }
    })
    .filter((entity) => entity.text)

  // The old shape listed names under `by_label`; VIDRA puts counts there.
  if (!rows.length) {
    for (const [label, values] of Object.entries(asRecord(raw.by_label))) {
      for (const text of asArray(values)) {
        rows.push({ text: labelOf(text), label, mentions: 1, chunk_ids: [] })
      }
    }
  }

  const groups = new Map<string, NamedEntity[]>()
  for (const row of rows) groups.set(row.label, [...(groups.get(row.label) ?? []), row])
  return [...groups.entries()]
    .map(([label, entities]) => ({
      label,
      entities: entities.sort((a, b) => b.mentions - a.mentions),
    }))
    .sort((a, b) => b.entities.length - a.entities.length)
}

// ------------------------------------------------------------------ sentiment

export interface SentimentAggregate {
  mean: number | null
  positive: number
  negative: number
  neutral: number
  turning_points: number[]
  model: string
  points: {
    chunk_id: number
    start: number
    end: number
    label: string
    signed: number
    text: string
  }[]
}

export function readSentiment(value: unknown): SentimentAggregate | null {
  const raw = asRecord(value)
  if (!Object.keys(raw).length) return null
  const overall = asRecord(raw.overall)
  const rows = asArray(raw.per_chunk).length ? asArray(raw.per_chunk) : asArray(raw.timeline)
  const points = rows.map((row) => {
    const entry = asRecord(row)
    const label = str(entry.label).toLowerCase()
    const score = num(entry.score, 0.5)
    return {
      chunk_id: num(entry.chunk_id, -1),
      start: firstNum(entry, ['start', 'start_ts']),
      end: firstNum(entry, ['end', 'end_ts']),
      label,
      signed:
        entry.signed !== undefined
          ? num(entry.signed)
          : label === 'positive'
            ? score
            : label === 'negative'
              ? -score
              : 0,
      text: str(entry.text),
    }
  })
  return {
    mean: raw.mean !== undefined ? num(raw.mean) : null,
    positive: firstNum(raw, ['positive_chunks'], num(overall.positive)),
    negative: firstNum(raw, ['negative_chunks'], num(overall.negative)),
    neutral: num(overall.neutral),
    turning_points: asArray(raw.turning_points).map((id) => num(id)),
    model: str(raw.model),
    points,
  }
}

// ------------------------------------------------------------------ people & objects

export interface Sighting {
  chunk_id: number
  start: number
  end: number
  name: string
  /** Every other descriptive field on the sighting, in the order it came. */
  details: { key: string; value: string }[]
  doubt: string
}

export interface EntityRow {
  id: string
  name: string
  description: string
  narrative: string
  roles: string[]
  appearances: number
  chunk_ids: number[]
  first_seen: number
  last_seen: number
  observed_seconds?: number
  distinctive: boolean
  sightings: Sighting[]
  doubts: string[]
  spans: { start: number; end: number }[]
}

const SIGHTING_SKIP = new Set([
  'key',
  'chunk_id',
  'sampler_id',
  'doubt',
  'start',
  'end',
  'start_ts',
  'end_ts',
  'locations',
  'box_id',
])

/**
 * People and objects followed across chunks, in either backend's shape.
 *
 * VIDRA labels an entity `"name; description"` and keeps every sighting under
 * `mentions`; the old core kept `observations` with fixed fields. Both become
 * one row with sightings placed in time from the chunk list.
 */
export function readEntities(
  value: unknown,
  kind: 'people' | 'objects',
  spans: ChunkSpans
): EntityRow[] {
  const raw = asRecord(value)
  const rows = asArray(raw.entities).length
    ? asArray(raw.entities)
    : kind === 'objects'
      ? asArray(raw.objects)
      : []

  return rows.map((row, rowIndex) => {
    const entity = asRecord(row)
    const id = str(entity.entity_id) || str(entity.object_id) || `#${rowIndex + 1}`
    const account = asRecord(entity.account)
    const rawLabel = str(entity.label) || labelOf(entity.name) || str(entity.role)
    const [head, ...rest] = rawLabel.split(/;\s*/)
    const signature = asRecord(parseLoose(entity.signature))

    const sightingRows = asArray(entity.mentions).length
      ? asArray(entity.mentions)
      : asArray(entity.observations)

    const sightings: Sighting[] = sightingRows.map((item) => {
      const sighting = asRecord(parseLoose(item))
      const chunkId = num(sighting.chunk_id, -1)
      const span = spans.get(chunkId)
      const name = labelOf(sighting.object ?? sighting.name ?? sighting.role ?? '')
      const details = Object.entries(sighting)
        .filter(([key, v]) => !SIGHTING_SKIP.has(key) && key !== 'object' && key !== 'name' && v)
        .map(([key, v]) => ({ key, value: labelOf(v) }))
        .filter((detail) => detail.value)
      return {
        chunk_id: chunkId,
        start: firstNum(sighting, ['start', 'start_ts'], span?.start ?? 0),
        end: firstNum(sighting, ['end', 'end_ts'], span?.end ?? 0),
        name,
        details,
        doubt: str(sighting.doubt),
      }
    })

    const chunkIds = asArray(entity.chunk_ids).map((chunkId) => num(chunkId))
    const name =
      str(account.name) ||
      sentenceCase(head || str(signature.object)) ||
      (kind === 'people' ? 'Person' : 'Object')
    const description =
      str(account.description) ||
      rest.join('; ') ||
      str(signature.appearance) ||
      (str(entity.description) !== rawLabel ? str(entity.description) : '')

    const timelineSpans = asArray(entity.spans).map((span) => ({
      start: firstNum(asRecord(span), ['start', 'start_ts']),
      end: firstNum(asRecord(span), ['end', 'end_ts']),
    }))

    return {
      id,
      name,
      description,
      narrative: str(account.narrative) || str(entity.narrative),
      roles: asArray(entity.roles).map(labelOf).filter(Boolean),
      appearances: num(entity.appearances, chunkIds.length || sightings.length),
      chunk_ids: chunkIds,
      first_seen: firstNum(entity, ['first_seen', 'start', 'start_ts']),
      last_seen: firstNum(entity, ['last_seen', 'end', 'end_ts']),
      observed_seconds:
        entity.observed_s !== undefined || entity.observed_seconds !== undefined
          ? firstNum(entity, ['observed_s', 'observed_seconds'])
          : undefined,
      distinctive: Boolean(entity.distinctive),
      sightings,
      doubts: asArray(entity.doubts)
        .map((doubt) => str(asRecord(doubt).reason) || str(doubt))
        .filter(Boolean),
      spans: timelineSpans.length
        ? timelineSpans
        : spansOf(chunkIds.length ? chunkIds : sightings.map((s) => s.chunk_id), spans),
    }
  })
}

/** Merge old-core `entity_timelines` presence onto the people it describes. */
export function withTimelines(entities: EntityRow[], timelines: unknown): EntityRow[] {
  const byId = new Map<string, Record<string, any>>()
  for (const row of asArray(asRecord(timelines).timelines)) {
    const timeline = asRecord(row)
    byId.set(str(timeline.entity_id), timeline)
  }
  if (byId.size === 0) return entities

  return entities.map((entity) => {
    const timeline = byId.get(entity.id)
    if (!timeline) return entity
    return {
      ...entity,
      observed_seconds: num(timeline.observed_seconds),
      spans: asArray(timeline.spans).map((span) => ({
        start: num(asRecord(span).start),
        end: num(asRecord(span).end),
      })),
    }
  })
}

/** Pairs of entities seen in the same chunks. */
export function readTogether(
  value: unknown
): { a: string; b: string; count: number; chunk_ids: number[] }[] {
  const raw = asRecord(value)
  const rows = asArray(raw.together).length ? asArray(raw.together) : asArray(raw.pairs)
  return rows
    .map((row) => {
      const pair = asRecord(row)
      const ids = asArray(pair.chunk_ids).length ? asArray(pair.chunk_ids) : asArray(pair.chunks)
      return {
        a: str(pair.a),
        b: str(pair.b),
        count: num(pair.count, ids.length),
        chunk_ids: ids.map((id) => num(id)),
      }
    })
    .filter((pair) => pair.a && pair.b)
    .sort((x, y) => y.count - x.count)
}

// ------------------------------------------------------------------ speakers

export interface SpeakerRow {
  speaker: string
  turns: number
  seconds: number
  words: number
  share: number
  longest_turn: number
  words_per_second: number
  first_seen: number
  last_seen: number
  chunks: number[]
}

export function readSpeakers(value: unknown): SpeakerRow[] {
  const raw = asRecord(value)
  const rows = asArray(raw.speakers).length ? asArray(raw.speakers) : asArray(raw.by_speaker)
  return rows
    .filter((row) => typeof row === 'object')
    .map((row) => {
      const speaker = asRecord(row)
      return {
        speaker: str(speaker.speaker),
        turns: num(speaker.turns),
        seconds: num(speaker.seconds),
        words: num(speaker.words),
        share: num(speaker.share),
        longest_turn: num(speaker.longest_turn),
        words_per_second: num(speaker.words_per_second),
        first_seen: num(speaker.first_seen),
        last_seen: num(speaker.last_seen),
        chunks: asArray(speaker.chunks).map((chunk) => num(chunk)),
      }
    })
}

/** Speaker totals in either shape. */
export function readSpeakerTotals(value: unknown) {
  const raw = asRecord(value)
  return {
    count: firstNum(raw, ['speaker_count'], typeof raw.speakers === 'number' ? raw.speakers : 0),
    turns: firstNum(raw, ['total_turns', 'turns']),
    handovers: num(raw.handovers),
    speech_seconds: firstNum(raw, ['total_speech_seconds', 'speech_s']),
    speech_ratio: raw.speech_ratio !== undefined ? num(raw.speech_ratio) : null,
    dominant: str(raw.dominant_speaker) || str(raw.dominant),
  }
}

/** `SPEAKER_00` → `Speaker 00`. The raw label is what filters use; this is for reading. */
export const speakerLabel = (speaker: string) =>
  speaker.replace(/^SPEAKER_/, 'Speaker ') || 'Unattributed'
