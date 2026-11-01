'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, Boxes, ChevronDown, Link2, UserRound, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration, formatTimestamp } from '@/lib/core/format'
import type { ChunkOut } from '@/lib/core/types'
import { Section, ShareBar, TimeLink } from './detail-primitives'
import {
  asRecord,
  chunkSpans,
  counted,
  num,
  readEntities,
  readTogether,
  sentenceCase,
  withTimelines,
  type EntityRow,
} from './aggregate-shapes'

interface EntitiesPanelProps {
  aggregates: Record<string, unknown>
  chunks: ChunkOut[]
  duration: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}

type Kind = 'people' | 'objects'

/**
 * People and objects followed across chunks.
 *
 * Linking is a similarity threshold over descriptions, so it is fallible in
 * both directions: one thing described two ways splits, two similar things
 * merge. Where the backend flagged sightings that contradict each other they
 * are shown as conflicts rather than hidden.
 */
export function EntitiesPanel({
  aggregates,
  chunks,
  duration,
  onSeek,
  onOpenChunk,
}: EntitiesPanelProps) {
  const spans = useMemo(() => chunkSpans(chunks), [chunks])
  const peopleRaw = asRecord(aggregates.entities)
  const objectsRaw = asRecord(aggregates.object_entities)

  const people = useMemo(
    () => withTimelines(readEntities(peopleRaw, 'people', spans), aggregates.entity_timelines),
    [peopleRaw, spans, aggregates.entity_timelines]
  )
  const objects = useMemo(() => readEntities(objectsRaw, 'objects', spans), [objectsRaw, spans])

  const [kind, setKind] = useState<Kind>(people.length ? 'people' : 'objects')
  const total = duration || chunks.at(-1)?.end || 0

  if (people.length === 0 && objects.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 py-16 text-center">
        <Users className="mx-auto size-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm font-medium">Nobody and nothing linked</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
          Linking people needs the <code className="text-[12px]">people</code> analyzer and linking
          objects needs <code className="text-[12px]">object_detection</code>. Neither ran on this
          video, so both aggregators were skipped.
        </p>
      </div>
    )
  }

  const raw = kind === 'people' ? peopleRaw : objectsRaw
  const rows = kind === 'people' ? people : objects
  const legacyCooccurrence = asRecord(aggregates.cooccurrence)

  return (
    <div className="space-y-4">
      {people.length > 0 && objects.length > 0 && (
        <div className="flex items-center gap-0.5 rounded-xl bg-muted/50 p-1 sm:w-fit">
          {(
            [
              { id: 'people', label: 'People', icon: UserRound, count: people.length },
              { id: 'objects', label: 'Objects', icon: Boxes, count: objects.length },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setKind(option.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-1.5 text-[13px] font-medium transition-colors',
                kind === option.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <option.icon className="size-3.5" />
              {option.label}
              <span className="text-[11px] tabular-nums text-muted-foreground">{option.count}</span>
            </button>
          ))}
        </div>
      )}

      <EntityGroup
        key={kind}
        kind={kind}
        raw={raw}
        rows={rows}
        legacyPairs={kind === 'people' ? readTogether(legacyCooccurrence) : []}
        duration={total}
        onSeek={onSeek}
        onOpenChunk={onOpenChunk}
      />

      {kind === 'objects' && counted(objectsRaw.fixtures).length > 0 && (
        <Section title="Fixtures" icon={<Boxes />} subtitle="counted, not tracked">
          <p className="mb-3 text-[12.5px] text-muted-foreground">
            Static things present in nearly every frame. Following them tells a search nothing.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {counted(objectsRaw.fixtures).map((fixture) => (
              <span
                key={fixture.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/70 py-0.5 pl-2.5 pr-1 text-[12px]"
              >
                {fixture.name}
                <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                  {fixture.count}
                </span>
              </span>
            ))}
          </div>
        </Section>
      )}

      {kind === 'objects' && counted(legacyCooccurrence.objects_present).length > 0 && (
        <Section title="Objects present" icon={<Boxes />}>
          <ul className="space-y-1.5">
            {counted(legacyCooccurrence.objects_present).map((object, index, all) => (
              <li key={object.name} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-[12.5px]">{object.name}</span>
                <ShareBar value={object.count / Math.max(1, all[0].count)} />
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {object.count}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

/** One kind's stats, its linked entities, the ones seen once, and who appears together. */
function EntityGroup({
  kind,
  raw,
  rows,
  legacyPairs,
  duration,
  onSeek,
  onOpenChunk,
}: {
  kind: Kind
  raw: Record<string, any>
  rows: EntityRow[]
  /** Old core kept people pairs in a separate `cooccurrence` aggregate. */
  legacyPairs: ReturnType<typeof readTogether>
  duration: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}) {
  const [showOnce, setShowOnce] = useState(true)
  const sorted = [...rows].sort((a, b) => b.appearances - a.appearances)
  const linked = sorted.filter((row) => row.appearances > 1)
  const once = sorted.filter((row) => row.appearances <= 1)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const together = readTogether(raw).filter((pair) => byId.has(pair.a) && byId.has(pair.b))
  const pairs = together.length ? together : legacyPairs
  const conflicts = rows.reduce((sum, row) => sum + (row.doubts.length ? 1 : 0), 0)
  const noun = kind === 'people' ? 'people' : 'objects'

  const tiles = [
    {
      label: kind === 'people' ? 'Distinct people' : 'Distinct objects',
      value: num(raw.count, rows.length) || rows.length,
    },
    { label: 'Linked across chunks', value: num(raw.linked, linked.length) },
    {
      label: 'Sightings',
      value:
        typeof raw.mentions === 'number'
          ? raw.mentions
          : num(raw.observations) || rows.reduce((s, r) => s + r.sightings.length, 0),
    },
    { label: 'Conflicts flagged', value: num(raw.doubted, conflicts) },
  ]

  return (
    <>
      <section className="rounded-2xl border border-border/60 bg-card/50 p-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.label}>
              <div className="text-[12px] text-muted-foreground">{tile.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
                {tile.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="space-y-2">
        {linked.map((entity, index) => (
          <EntityCard
            key={entity.id}
            entity={entity}
            kind={kind}
            tone={index}
            duration={duration}
            onSeek={onSeek}
            onOpenChunk={onOpenChunk}
          />
        ))}
      </div>

      {once.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowOnce((value) => !value)}
            className="flex w-full items-center gap-2 rounded-xl px-1 py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn('size-4 transition-transform', !showOnce && '-rotate-90')} />
            Seen only once
            <span className="tabular-nums text-muted-foreground/70">{once.length}</span>
            <span className="h-px flex-1 bg-border/60" />
          </button>
          {showOnce && (
            <div className="mt-2 space-y-2">
              {once.map((entity, index) => (
                <EntityCard
                  key={entity.id}
                  entity={entity}
                  kind={kind}
                  tone={linked.length + index}
                  duration={duration}
                  onSeek={onSeek}
                  onOpenChunk={onOpenChunk}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {pairs.length > 0 && (
        <Section
          title="Seen together"
          icon={<Link2 />}
          count={pairs.length}
          subtitle={`${noun} sharing a chunk`}
        >
          <ul className="space-y-2">
            {pairs.slice(0, 20).map((pair, index) => {
              const a = byId.get(pair.a)
              const b = byId.get(pair.b)
              return (
                <li key={index} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {a?.name ?? pair.a}
                    <span className="mx-2 text-muted-foreground/60">+</span>
                    {b?.name ?? pair.b}
                  </span>
                  <ShareBar value={pair.count / Math.max(1, pairs[0].count)} className="w-28" />
                  <button
                    type="button"
                    onClick={() => pair.chunk_ids.length && onOpenChunk(pair.chunk_ids[0])}
                    className="w-16 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground hover:text-foreground"
                  >
                    {pair.count} chunk{pair.count === 1 ? '' : 's'}
                  </button>
                </li>
              )
            })}
          </ul>
        </Section>
      )}
    </>
  )
}

const ENTITY_TONES = [
  'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  'bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'bg-teal-500/15 text-teal-600 dark:text-teal-300',
]

const STRIP_TONES = [
  'bg-sky-400',
  'bg-violet-400',
  'bg-emerald-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-teal-400',
]

/** One linked person or object: what it is, when it was there, and every sighting. */
function EntityCard({
  entity,
  kind,
  tone,
  duration,
  onSeek,
  onOpenChunk,
}: {
  entity: EntityRow
  kind: Kind
  tone: number
  duration: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}) {
  const [open, setOpen] = useState(true)
  const Icon = kind === 'people' ? UserRound : Boxes
  const presence =
    entity.observed_seconds !== undefined && duration > 0
      ? entity.observed_seconds / duration
      : null

  return (
    <article
      className={cn(
        'rounded-2xl border bg-card/50 transition-colors',
        open ? 'border-border' : 'border-border/60 hover:border-border'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-4 p-4 text-left"
      >
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            ENTITY_TONES[tone % ENTITY_TONES.length]
          )}
        >
          <Icon className="size-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium tracking-tight">{entity.name}</span>
            {entity.distinctive && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-px text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                distinctive
              </span>
            )}
            {entity.doubts.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-px text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {entity.doubts.length} conflict{entity.doubts.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
          {entity.description && (
            <span
              className={cn(
                'mt-1 block text-[13px] leading-relaxed text-muted-foreground',
                !open && 'line-clamp-2'
              )}
            >
              {sentenceCase(entity.description)}
            </span>
          )}

          {duration > 0 && entity.spans.length > 0 && (
            <PresenceStrip
              spans={entity.spans}
              duration={duration}
              tone={STRIP_TONES[tone % STRIP_TONES.length]}
              onSeek={onSeek}
            />
          )}

          <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span>
              {formatTimestamp(entity.first_seen)} – {formatTimestamp(entity.last_seen)}
            </span>
            {entity.observed_seconds !== undefined && (
              <span>
                on screen {formatDuration(entity.observed_seconds)}
                {presence !== null && ` · ${Math.round(presence * 100)}%`}
              </span>
            )}
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-xl font-semibold tabular-nums leading-none tracking-tight">
            {entity.appearances}
          </span>
          <span className="text-[11px] text-muted-foreground">
            chunk{entity.appearances === 1 ? '' : 's'}
          </span>
          <ChevronDown
            className={cn(
              'mt-1 size-4 text-muted-foreground/60 transition-transform',
              open && 'rotate-180'
            )}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-border/50 px-4 pb-4 pt-4 sm:pl-18">
          {entity.narrative && (
            <p className="mb-4 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-foreground/80">
              {entity.narrative}
            </p>
          )}

          {entity.roles.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {entity.roles.map((role) => (
                <span
                  key={role}
                  className="rounded-full border border-border/70 px-2 py-0.5 text-[11.5px] text-foreground/80"
                >
                  {role}
                </span>
              ))}
            </div>
          )}

          <h4 className="mb-2 text-[12px] font-medium text-muted-foreground">
            Sightings{' '}
            <span className="tabular-nums text-muted-foreground/70">{entity.sightings.length}</span>
          </h4>
          <ol className="space-y-1">
            {entity.sightings.map((sighting, index) => (
              <li
                key={index}
                className={cn(
                  'grid grid-cols-[auto_1fr] gap-x-3 rounded-xl px-3 py-2.5',
                  sighting.doubt ? 'bg-amber-500/5' : 'bg-muted/30'
                )}
              >
                <div className="flex flex-col items-start gap-0.5">
                  <TimeLink
                    seconds={sighting.start}
                    onSeek={onSeek}
                    showIcon
                    className="font-medium"
                  />
                  {sighting.chunk_id >= 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenChunk(sighting.chunk_id)}
                      className="px-1 text-[10.5px] text-muted-foreground/70 hover:text-foreground"
                    >
                      chunk {sighting.chunk_id} →
                    </button>
                  )}
                </div>
                <div className="min-w-0 text-[13px] leading-relaxed">
                  {sighting.name && (
                    <span className="font-medium">{sentenceCase(sighting.name)}</span>
                  )}
                  {sighting.details.map((detail) => (
                    <p key={detail.key} className="text-foreground/75">
                      {sighting.details.length > 1 && (
                        <span className="mr-1.5 text-[11px] capitalize text-muted-foreground">
                          {detail.key.replace(/_/g, ' ')}
                        </span>
                      )}
                      {detail.value}
                    </p>
                  ))}
                  {sighting.doubt && (
                    <p className="mt-1 flex gap-1.5 text-[12px] text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {sighting.doubt}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </article>
  )
}

/** Where in the video this entity was actually observed. */
function PresenceStrip({
  spans,
  duration,
  tone,
  onSeek,
}: {
  spans: { start: number; end: number }[]
  duration: number
  tone: string
  onSeek: (seconds: number) => void
}) {
  return (
    <span className="relative mt-3 block h-1.5 w-full overflow-hidden rounded-full bg-muted/70">
      {spans.map((span, index) => {
        const left = (span.start / duration) * 100
        const width = Math.max(0.6, ((span.end - span.start) / duration) * 100)
        return (
          <span
            key={index}
            role="button"
            tabIndex={-1}
            onClick={(event) => {
              event.stopPropagation()
              onSeek(span.start)
            }}
            title={`${formatTimestamp(span.start)} – ${formatTimestamp(span.end)}`}
            className={cn('absolute top-0 h-full rounded-full opacity-80 hover:opacity-100', tone)}
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        )
      })}
    </span>
  )
}
