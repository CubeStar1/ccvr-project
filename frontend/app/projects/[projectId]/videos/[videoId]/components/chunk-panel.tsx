'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Boxes,
  Captions,
  Eye,
  Film,
  LayoutList,
  Play,
  Rows3,
  Search,
  Type,
  Users,
  X,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatTimestamp } from '@/lib/core/format'
import type { AnalyzerId, ChunkOut } from '@/lib/core/types'
import { Chips, EmptyNote, JsonView, RawDisclosure, TimeLink } from './detail-primitives'
import { asRecord, labelOf, parseLoose, readDetections, str } from './aggregate-shapes'

/** Rendering 500 expanded chunks at once is what makes this page feel slow. */
const INITIAL_RENDER = 25

const ANALYZER_LABELS: Record<string, string> = {
  default_video: 'Scene',
  transcript: 'Transcript',
  diarization: 'Speech',
  ocr: 'On-screen text',
  people: 'People',
  object_detection: 'Objects',
}

const ANALYZER_ICONS: Record<string, React.ReactNode> = {
  default_video: <Eye className="size-3.5" />,
  transcript: <Captions className="size-3.5" />,
  diarization: <Captions className="size-3.5" />,
  ocr: <Type className="size-3.5" />,
  people: <Users className="size-3.5" />,
  object_detection: <Boxes className="size-3.5" />,
}

/**
 * One hue per analyzer, used sparingly — a dot or an icon — so "this came from
 * OCR" reads at a glance without the page turning into a paint chart.
 */
const ANALYZER_TONES: Record<string, { bar: string; text: string }> = {
  default_video: { bar: 'bg-sky-400', text: 'text-sky-500 dark:text-sky-400' },
  diarization: { bar: 'bg-violet-400', text: 'text-violet-500 dark:text-violet-400' },
  transcript: { bar: 'bg-violet-400', text: 'text-violet-500 dark:text-violet-400' },
  ocr: { bar: 'bg-amber-400', text: 'text-amber-500 dark:text-amber-400' },
  people: { bar: 'bg-emerald-400', text: 'text-emerald-500 dark:text-emerald-400' },
  object_detection: { bar: 'bg-rose-400', text: 'text-rose-500 dark:text-rose-400' },
}

/** Stable per-speaker colour, so the same voice looks the same in every chunk. */
const SPEAKER_TONES = [
  'bg-violet-500',
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-teal-500',
]

/** `SPEAKER_03` → `3`, for the avatar dot beside each turn. */
function speakerInitial(speaker: string | undefined) {
  const digits = speaker?.replace(/\D/g, '') ?? ''
  return digits ? String(Number(digits)) : '?'
}

function speakerTone(speaker: string | undefined) {
  if (!speaker) return 'bg-muted-foreground'
  const index = Number(speaker.replace(/\D/g, '')) || 0
  return SPEAKER_TONES[index % SPEAKER_TONES.length]
}

const ANALYZER_ORDER: AnalyzerId[] = [
  'default_video',
  'diarization',
  'transcript',
  'ocr',
  'people',
  'object_detection',
]

/** Which analyzers actually left output on this chunk. */
function analyzersOn(chunk: ChunkOut): AnalyzerId[] {
  return ANALYZER_ORDER.filter((id) => {
    const output = (chunk as unknown as Record<string, unknown>)[id]
    return output !== undefined && output !== null && Object.keys(output as object).length > 0
  })
}

/** A one-line stand-in for a chunk, for the compact rows and the timeline tooltip. */
function chunkGist(chunk: ChunkOut): string {
  return (
    chunk.default_video?.description ||
    chunk.ocr?.summary ||
    chunk.transcript?.text ||
    (chunk.diarization?.turns ?? []).map((turn) => turn.text).join(' ') ||
    (chunk.object_detection?.objects ?? []).map(labelOf).join(', ') ||
    'No description'
  )
}

/** Everything textual in a chunk, flattened once so search can scan it. */
function searchableText(chunk: ChunkOut): string {
  const scene = chunk.default_video ?? {}
  return [
    scene.description,
    scene.setting,
    ...(scene.people ?? []),
    ...(scene.objects ?? []),
    ...(scene.actions ?? []),
    ...(scene.tags ?? []),
    chunk.transcript?.text,
    ...(chunk.diarization?.turns ?? []).map((turn) => `${turn.speaker} ${turn.text}`),
    ...(chunk.ocr?.texts ?? []).map((entry) => entry.text),
    chunk.ocr?.summary,
    ...(chunk.people?.people ?? []).map((person) =>
      ['appearance', 'clothing', 'role', 'action']
        .map((key) => (person as Record<string, unknown>)[key])
        .join(' ')
    ),
    ...readDetections(chunk.object_detection?.detections, chunk.object_detection?.objects).map(
      (detection) => `${detection.object} ${detection.appearance} ${detection.context}`
    ),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

interface ChunkPanelProps {
  chunks: ChunkOut[]
  chunkTotal: number
  analyzers: AnalyzerId[]
  duration: number
  currentTime: number
  focusChunkId: number | null
  onSeek: (seconds: number) => void
}

/**
 * Every chunk, with every analyzer's output on it.
 *
 * Core already merges the analyzers onto the chunk before returning it, so a
 * chunk is one row here rather than one row per pass — which is also how it is
 * stored, and the reason the same moment can be read across passes at all.
 */
export function ChunkPanel({
  chunks,
  chunkTotal,
  analyzers,
  duration,
  currentTime,
  focusChunkId,
  onSeek,
}: ChunkPanelProps) {
  const [search, setSearch] = useState('')
  const [analyzerFilter, setAnalyzerFilter] = useState<AnalyzerId | 'all'>('all')
  const [dense, setDense] = useState(false)
  const [rendered, setRendered] = useState(INITIAL_RENDER)
  const [selected, setSelected] = useState<number | null>(null)

  // Searchable text is the expensive part of filtering, and it never changes.
  const indexed = useMemo(
    () => chunks.map((chunk) => ({ chunk, text: searchableText(chunk) })),
    [chunks]
  )

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return indexed
      .filter(({ chunk, text }) => {
        if (analyzerFilter !== 'all' && !analyzersOn(chunk).includes(analyzerFilter)) return false
        return term ? text.includes(term) : true
      })
      .map(({ chunk }) => chunk)
  }, [indexed, search, analyzerFilter])

  const matched = useMemo(() => new Set(filtered.map((chunk) => chunk.chunk_id)), [filtered])

  useEffect(() => setRendered(INITIAL_RENDER), [search, analyzerFilter, dense])

  // A jump from another tab must survive the render cap, or the target chunk is
  // simply not on the page to scroll to.
  useEffect(() => {
    if (focusChunkId === null) return
    setSelected(focusChunkId)
    const position = filtered.findIndex((chunk) => chunk.chunk_id === focusChunkId)
    if (position >= 0) setRendered((current) => Math.max(current, position + 5))

    const timer = window.setTimeout(() => {
      document
        .getElementById(`chunk-${focusChunkId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    return () => window.clearTimeout(timer)
  }, [focusChunkId, filtered])

  const visible = filtered.slice(0, rendered)
  const remaining = filtered.length - visible.length
  const positions = useMemo(
    () => new Map(chunks.map((chunk, index) => [chunk.chunk_id, index])),
    [chunks]
  )

  return (
    <div className="space-y-4">
      {duration > 0 && chunks.length > 0 && (
        <ChunkTimeline
          chunks={chunks}
          duration={duration}
          currentTime={currentTime}
          matched={matched}
          isFiltered={filtered.length !== chunks.length}
          selected={selected}
          onPick={(chunk) => {
            setSelected(chunk.chunk_id)
            onSeek(chunk.start)
            const position = filtered.findIndex((row) => row.chunk_id === chunk.chunk_id)
            if (position >= 0) setRendered((current) => Math.max(current, position + 5))
            window.setTimeout(
              () =>
                document
                  .getElementById(`chunk-${chunk.chunk_id}`)
                  ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
              60
            )
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search scenes, speech, text, people, objects…"
            className="h-9 rounded-xl border-border/60 bg-card/50 pl-9 pr-8 text-[13px] shadow-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {analyzers.length > 1 && (
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            <FilterPill
              active={analyzerFilter === 'all'}
              onClick={() => setAnalyzerFilter('all')}
              label="All"
            />
            {analyzers.map((id) => (
              <FilterPill
                key={id}
                active={analyzerFilter === id}
                onClick={() => setAnalyzerFilter(id)}
                label={ANALYZER_LABELS[id] ?? id}
                dot={ANALYZER_TONES[id]?.bar}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
          <button
            type="button"
            onClick={() => setDense(false)}
            title="Full detail"
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              !dense
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <LayoutList className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setDense(true)}
            title="Compact rows"
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              dense
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Rows3 className="size-3.5" />
          </button>
        </div>
      </div>

      {(filtered.length !== chunks.length || chunkTotal > chunks.length) && (
        <p className="px-1 text-[12px] text-muted-foreground">
          {filtered.length} of {chunks.length} chunks
          {chunkTotal > chunks.length && ` · core holds ${chunkTotal}`}
        </p>
      )}

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 py-16 text-center">
          <Film className="mx-auto size-6 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium">
            {chunks.length === 0 ? 'No chunks stored' : 'No chunks match'}
          </p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {chunks.length === 0
              ? 'This video has not been chunked yet, or the analysis backend is unreachable.'
              : 'Try a different search term or analyzer.'}
          </p>
        </div>
      ) : dense ? (
        <ul className="overflow-hidden rounded-2xl border border-border/60 bg-card/50">
          {visible.map((chunk) => (
            <CompactRow
              key={`${chunk.chunk_id}-${chunk.start}`}
              chunk={chunk}
              index={positions.get(chunk.chunk_id) ?? 0}
              isActive={currentTime >= chunk.start && currentTime < chunk.end}
              isSelected={selected === chunk.chunk_id}
              onSelect={() => {
                setSelected(chunk.chunk_id)
                onSeek(chunk.start)
              }}
            />
          ))}
        </ul>
      ) : (
        <ul className="space-y-3">
          {visible.map((chunk) => (
            <ChunkCard
              key={`${chunk.chunk_id}-${chunk.start}`}
              chunk={chunk}
              index={positions.get(chunk.chunk_id) ?? 0}
              isActive={currentTime >= chunk.start && currentTime < chunk.end}
              isSelected={selected === chunk.chunk_id}
              analyzerFilter={analyzerFilter}
              onSeek={onSeek}
            />
          ))}
        </ul>
      )}

      {remaining > 0 && (
        <div className="pt-1 text-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRendered((current) => current + 40)}
          >
            Show {Math.min(remaining, 40)} more ({remaining} left)
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The whole video as one strip, a block per chunk.
 *
 * Chunks are not fixed spans — the boundary detectors cut where the content
 * changes — so their widths are the clearest picture of how the video was
 * divided, and where the analysis is dense or thin.
 */
function ChunkTimeline({
  chunks,
  duration,
  currentTime,
  matched,
  isFiltered,
  selected,
  onPick,
}: {
  chunks: ChunkOut[]
  duration: number
  currentTime: number
  matched: Set<number>
  isFiltered: boolean
  selected: number | null
  onPick: (chunk: ChunkOut) => void
}) {
  const [hovered, setHovered] = useState<ChunkOut | null>(null)
  const legend = ANALYZER_ORDER.filter((id) =>
    chunks.some((chunk) => analyzersOn(chunk).includes(id))
  )

  return (
    <div className="rounded-2xl border border-border/60 bg-card/50 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <span className="text-[13px] font-medium tracking-tight">Timeline</span>
          <div className="hidden items-center gap-3 sm:flex">
            {legend.map((id) => (
              <span
                key={id}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <span className={cn('size-1.5 rounded-full', ANALYZER_TONES[id]?.bar)} />
                {ANALYZER_LABELS[id] ?? id}
              </span>
            ))}
          </div>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
        </span>
      </div>

      <div
        className="relative h-12 w-full overflow-hidden rounded-lg bg-muted/30"
        onMouseLeave={() => setHovered(null)}
      >
        {chunks.map((chunk) => {
          const present = analyzersOn(chunk)
          const left = (chunk.start / duration) * 100
          const width = Math.max(0.15, ((chunk.end - chunk.start) / duration) * 100)
          const isActive = currentTime >= chunk.start && currentTime < chunk.end
          const dimmed = isFiltered && !matched.has(chunk.chunk_id)

          return (
            <button
              key={chunk.chunk_id}
              type="button"
              onMouseEnter={() => setHovered(chunk)}
              onClick={() => onPick(chunk)}
              aria-label={`Chunk ${chunk.chunk_id}`}
              className={cn(
                'group absolute inset-y-0 flex flex-col justify-end gap-[3px] px-[1.5px] pb-1.5 transition-colors',
                dimmed ? 'opacity-20' : 'hover:bg-foreground/5',
                (isActive || selected === chunk.chunk_id) && 'bg-foreground/[0.07]'
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              {/* One band per pass that produced output — a tall stack is a
                  richly analysed moment, a short one is a gap. */}
              {ANALYZER_ORDER.filter((id) => present.includes(id)).map((id) => (
                <span
                  key={id}
                  className={cn(
                    'h-1 w-full rounded-full opacity-60 transition-opacity group-hover:opacity-100',
                    ANALYZER_TONES[id]?.bar ?? 'bg-primary',
                    isActive && 'opacity-100'
                  )}
                />
              ))}
            </button>
          )
        })}

        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-px bg-foreground"
          style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
        />
      </div>

      <p className="mt-2.5 h-4 truncate text-[12px] text-muted-foreground">
        {hovered ? (
          <>
            <span className="tabular-nums text-foreground/80">
              {formatTimestamp(hovered.start)}–{formatTimestamp(hovered.end)}
            </span>
            <span className="mx-1.5 text-muted-foreground/50">·</span>
            {chunkGist(hovered)}
          </>
        ) : (
          `${chunks.length} chunks · click one to jump there`
        )}
      </p>
    </div>
  )
}

function FilterPill({
  active,
  onClick,
  label,
  dot,
}: {
  active: boolean
  onClick: () => void
  label: string
  dot?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', dot)} />}
      {label}
    </button>
  )
}

/** One line per chunk, for scanning a long video rather than reading it. */
function CompactRow({
  chunk,
  index,
  isActive,
  isSelected,
  onSelect,
}: {
  chunk: ChunkOut
  index: number
  isActive: boolean
  isSelected: boolean
  onSelect: () => void
}) {
  const present = analyzersOn(chunk)

  return (
    <li
      id={`chunk-${chunk.chunk_id}`}
      className="scroll-mt-24 border-b border-border/50 last:border-0"
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-4 px-4 py-2.5 text-left transition-colors',
          isSelected ? 'bg-muted/60' : isActive ? 'bg-muted/40' : 'hover:bg-muted/30'
        )}
      >
        <span className="w-6 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span
          className={cn(
            'w-24 shrink-0 text-[12px] tabular-nums',
            isActive ? 'font-medium text-foreground' : 'text-muted-foreground'
          )}
        >
          {formatTimestamp(chunk.start)}–{formatTimestamp(chunk.end)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
          {chunkGist(chunk)}
        </span>
        <span className="flex shrink-0 gap-1">
          {present.map((id) => (
            <span
              key={id}
              title={ANALYZER_LABELS[id] ?? id}
              className={cn('size-1.5 rounded-full', ANALYZER_TONES[id]?.bar)}
            />
          ))}
        </span>
      </button>
    </li>
  )
}

function ChunkCard({
  chunk,
  index,
  isActive,
  isSelected,
  analyzerFilter,
  onSeek,
}: {
  chunk: ChunkOut
  index: number
  isActive: boolean
  isSelected: boolean
  analyzerFilter: AnalyzerId | 'all'
  onSeek: (seconds: number) => void
}) {
  const present = analyzersOn(chunk)
  const shows = (id: AnalyzerId) => analyzerFilter === 'all' || analyzerFilter === id

  const scene = chunk.default_video
  const people = chunk.people
  const objects = chunk.object_detection
  const detections = objects ? readDetections(objects.detections, objects.objects) : []
  const length = chunk.end - chunk.start

  return (
    <li
      id={`chunk-${chunk.chunk_id}`}
      className={cn(
        'scroll-mt-24 rounded-2xl border bg-card/50 transition-colors duration-300',
        isActive ? 'border-foreground/25 bg-card' : 'border-border/60',
        isSelected && 'ring-1 ring-foreground/20'
      )}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">
          {String(index + 1).padStart(2, '0')}
        </span>
        <button
          type="button"
          onClick={() => onSeek(chunk.start)}
          title="Play from here"
          className={cn(
            'inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[12.5px] font-medium tabular-nums transition-colors',
            isActive ? 'bg-foreground text-background' : 'bg-muted/60 hover:bg-muted'
          )}
        >
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full',
              isActive ? 'bg-background/20' : 'bg-background'
            )}
          >
            <Play className="size-2.5 translate-x-px fill-current" />
          </span>
          {formatTimestamp(chunk.start)} – {formatTimestamp(chunk.end)}
        </button>
        <span className="text-[12px] tabular-nums text-muted-foreground">{length.toFixed(1)}s</span>

        <div className="ml-auto flex flex-wrap items-center gap-3">
          {present.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={id}
            >
              <span className={cn('size-1.5 rounded-full', ANALYZER_TONES[id]?.bar)} />
              {ANALYZER_LABELS[id] ?? id}
            </span>
          ))}
        </div>
      </header>

      <div className="space-y-6 px-5 pb-4 pt-4">
        {present.length === 0 && <EmptyNote>No analyzer produced output for this chunk.</EmptyNote>}

        {scene && shows('default_video') && (
          <Block id="default_video">
            {scene.description && (
              <p className="text-[14px] leading-[1.75] text-foreground/90">{scene.description}</p>
            )}
            <dl className="mt-4 grid grid-cols-[64px_1fr] gap-x-4 gap-y-3 text-[13px]">
              {scene.setting && (
                <Facet label="Setting">
                  <span className="text-foreground/80">{labelOf(scene.setting)}</span>
                </Facet>
              )}
              {(scene.actions ?? []).length > 0 && (
                <Facet label="Actions">
                  <ul className="space-y-1">
                    {(scene.actions ?? []).map((action, actionIndex) => (
                      <li key={actionIndex} className="flex gap-2 text-foreground/80">
                        <span className="mt-[9px] size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                        {labelOf(action)}
                      </li>
                    ))}
                  </ul>
                </Facet>
              )}
              {(scene.people ?? []).length > 0 && (
                <Facet label="People">
                  <Chips items={(scene.people ?? []).map(labelOf)} tone="outline" />
                </Facet>
              )}
              {(scene.objects ?? []).length > 0 && (
                <Facet label="Objects">
                  <Chips items={(scene.objects ?? []).map(labelOf)} tone="outline" />
                </Facet>
              )}
              {(scene.tags ?? []).length > 0 && (
                <Facet label="Tags">
                  <div className="flex flex-wrap gap-x-2.5 gap-y-1 pt-0.5 text-[12px] text-muted-foreground">
                    {(scene.tags ?? []).map((tag, tagIndex) => (
                      <span key={`${tag}-${tagIndex}`}>#{labelOf(tag).replace(/\s+/g, '-')}</span>
                    ))}
                  </div>
                </Facet>
              )}
            </dl>
          </Block>
        )}

        {chunk.diarization && shows('diarization') && (
          <Block
            id="diarization"
            note={
              (chunk.diarization.speakers ?? []).length
                ? `${(chunk.diarization.speakers ?? []).length} speaker${
                    (chunk.diarization.speakers ?? []).length === 1 ? '' : 's'
                  }`
                : undefined
            }
          >
            {(chunk.diarization.turns ?? []).length === 0 ? (
              <EmptyNote>No speech in this chunk.</EmptyNote>
            ) : (
              <ul className="space-y-3">
                {(chunk.diarization.turns ?? []).map((turn, turnIndex) => (
                  <li key={`${turn.start}-${turnIndex}`} className="flex items-start gap-3">
                    <span
                      className={cn(
                        'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white',
                        speakerTone(turn.speaker)
                      )}
                    >
                      {speakerInitial(turn.speaker)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[12px] font-medium">
                          {turn.speaker?.replace(/^SPEAKER_/, 'Speaker ') ?? 'Unattributed'}
                        </span>
                        <TimeLink seconds={turn.start} end={turn.end} onSeek={onSeek} />
                      </div>
                      <p className="mt-0.5 text-[13.5px] leading-relaxed text-foreground/85">
                        {turn.text}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        )}

        {chunk.transcript && shows('transcript') && (
          <Block id="transcript">
            {chunk.transcript.text?.trim() ? (
              <blockquote className="border-l-2 border-border pl-4 text-[13.5px] leading-relaxed text-foreground/85">
                {chunk.transcript.text}
              </blockquote>
            ) : (
              <EmptyNote>No speech in this chunk.</EmptyNote>
            )}
          </Block>
        )}

        {chunk.ocr && shows('ocr') && (
          <Block id="ocr">
            {chunk.ocr.summary && (
              <p className="mb-3 text-[13px] leading-relaxed text-foreground/80">
                {chunk.ocr.summary}
              </p>
            )}
            {(chunk.ocr.texts ?? []).length === 0 ? (
              <EmptyNote>No text detected on screen.</EmptyNote>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {(chunk.ocr.texts ?? []).map((entry, textIndex) => {
                  const parsed = asRecord(parseLoose(entry.text))
                  const text = str(parsed.text) || labelOf(entry.text)
                  const context = str(entry.context) || str(parsed.context)
                  return (
                    <li key={textIndex} className="rounded-xl bg-muted/40 px-3.5 py-2.5">
                      <span className="font-mono text-[12.5px] leading-snug text-foreground">
                        {text}
                      </span>
                      {context && (
                        <span className="mt-1 block text-[12px] leading-snug text-muted-foreground">
                          {context}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Block>
        )}

        {people && shows('people') && (
          <Block
            id="people"
            note={people.people_count !== undefined ? `${people.people_count} detected` : undefined}
          >
            {(people.people ?? []).length === 0 ? (
              <EmptyNote>Nobody described in this chunk.</EmptyNote>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {(people.people ?? []).map((person, personIndex) => (
                  <PersonCard
                    key={personIndex}
                    person={asRecord(parseLoose(person))}
                    index={personIndex}
                  />
                ))}
              </ul>
            )}
          </Block>
        )}

        {objects && shows('object_detection') && (
          <Block
            id="object_detection"
            note={detections.length ? `${detections.length} found` : undefined}
          >
            {detections.length === 0 ? (
              <EmptyNote>No objects described in this chunk.</EmptyNote>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {detections.map((detection, detectionIndex) => (
                  <li key={detectionIndex} className="rounded-xl bg-muted/40 px-3.5 py-3">
                    <div className="flex items-center gap-2">
                      <span className="size-1.5 shrink-0 rounded-full bg-rose-400" />
                      <span className="text-[13px] font-medium">{detection.object}</span>
                    </div>
                    {detection.appearance && (
                      <p className="mt-1.5 text-[12.5px] leading-relaxed text-foreground/75">
                        {detection.appearance}
                      </p>
                    )}
                    {detection.context && (
                      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                        {detection.context}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Block>
        )}

        <RawDisclosure label="Raw chunk record" value={chunk} />
      </div>
    </li>
  )
}

function Block({
  id,
  note,
  children,
}: {
  id: AnalyzerId
  note?: string
  children: React.ReactNode
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span className={cn('[&_svg]:size-3.5', ANALYZER_TONES[id]?.text)}>
          {ANALYZER_ICONS[id]}
        </span>
        {ANALYZER_LABELS[id] ?? id}
        {note && (
          <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
            · {note}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function Facet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

/**
 * One person as the analyzer described them. `box_id` is shown because it is
 * how the description ties back to a box in the frame — but it is a referent
 * within this chunk, not an identity across the video.
 */
function PersonCard({ person, index }: { person: Record<string, unknown>; index: number }) {
  const known = ['box_id', 'appearance', 'clothing', 'role', 'action', 'description']
  const extra = Object.fromEntries(
    Object.entries(person).filter(([key]) => !known.includes(key) && key !== 'locations')
  )

  return (
    <li className="rounded-xl bg-muted/40 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-[10px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-300">
          {(person.box_id as number) ?? index + 1}
        </span>
        <span className="text-[13px] font-medium capitalize">
          {person.role ? labelOf(person.role) : `Person ${index + 1}`}
        </span>
      </div>
      {Boolean(person.description) && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-foreground/75">
          {labelOf(person.description)}
        </p>
      )}
      <dl className="mt-2 space-y-1">
        {(['clothing', 'appearance', 'action'] as const).map((key) =>
          person[key] ? (
            <div key={key} className="flex gap-2">
              <dt className="w-16 shrink-0 text-[11px] capitalize text-muted-foreground">{key}</dt>
              <dd className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground/80">
                {labelOf(person[key])}
              </dd>
            </div>
          ) : null
        )}
      </dl>
      {Object.keys(extra).length > 0 && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <JsonView value={extra} depth={1} />
        </div>
      )}
    </li>
  )
}
