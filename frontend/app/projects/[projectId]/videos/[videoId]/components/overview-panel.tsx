'use client'

import { useState } from 'react'
import {
  BookOpen,
  FileText,
  Gauge,
  Layers,
  ListTree,
  MapPin,
  Sparkles,
  Tag,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration, formatTimestamp } from '@/lib/core/format'
import { EmptyNote, Section, ShareBar, TimeLink } from './detail-primitives'
import {
  asArray,
  asRecord,
  counted,
  num,
  readChapters,
  readCoverage,
  readEvents,
  readNamedEntities,
  readSentiment,
  readStats,
  readSummary,
  sentenceCase,
  str,
  type CoverageAggregate,
  type SentimentAggregate,
  type StatsAggregate,
} from './aggregate-shapes'

interface OverviewPanelProps {
  aggregates: Record<string, unknown>
  duration: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}

/**
 * The video-level read: what it is about, how it is divided, what happened, and
 * the counts embeddings cannot produce.
 *
 * Everything here is an aggregate, and an aggregate whose analyzer never ran is
 * absent rather than empty — so a missing block is simply not drawn.
 */
export function OverviewPanel({ aggregates, duration, onSeek, onOpenChunk }: OverviewPanelProps) {
  const summary = readSummary(aggregates.summary)
  const stats = readStats(aggregates.stats)
  const coverage = readCoverage(aggregates.coverage)
  const chapters = readChapters(aggregates.chapters)
  const events = readEvents(aggregates.events)
  const named = readNamedEntities(aggregates.ner)
  const sentiment = readSentiment(aggregates.sentiment)
  const novelty = asRecord(aggregates.novelty)
  const length = duration || stats?.duration || 0

  const hasAnything =
    summary || stats || chapters.length || events.length || named.length || sentiment

  if (!hasAnything) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 py-16 text-center">
        <Sparkles className="mx-auto size-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm font-medium">No video-level results yet</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
          Aggregators run after analysis and are skipped when the analyzer they depend on was not
          selected. Re-run them from the header menu to fill this in.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {summary && <SummaryCard summary={summary} onSeek={onSeek} onOpenChunk={onOpenChunk} />}

      {stats && (
        <AtAGlance stats={stats} coverage={coverage} events={events.length} length={length} />
      )}

      {chapters.length > 0 && (
        <ChaptersSection
          chapters={chapters}
          duration={length}
          onSeek={onSeek}
          onOpenChunk={onOpenChunk}
        />
      )}

      {events.length > 0 && (
        <EventsSection events={events} onSeek={onSeek} onOpenChunk={onOpenChunk} />
      )}

      {sentiment && sentiment.points.length > 0 && (
        <ToneSection sentiment={sentiment} duration={length} onSeek={onSeek} />
      )}

      {named.length > 0 && <NamedEntitiesSection groups={named} onOpenChunk={onOpenChunk} />}

      {Object.keys(novelty).length > 0 && <NoveltySection novelty={novelty} onSeek={onSeek} />}
    </div>
  )
}

// ------------------------------------------------------------------ summary

function SummaryCard({
  summary,
  onSeek,
  onOpenChunk,
}: {
  summary: NonNullable<ReturnType<typeof readSummary>>
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}) {
  // `tiers[0]` is the finest level and the last is the coarsest.
  const [tier, setTier] = useState(() => Math.max(0, summary.tiers.length - 1))
  const sections = summary.tiers[tier]?.sections ?? []
  const meta = [
    summary.word_count ? `${summary.word_count} words` : '',
    summary.chunks_read ? `read from ${summary.chunks_read} chunks` : '',
    summary.based_on.length ? `from ${summary.based_on.join(', ')}` : '',
  ].filter(Boolean)

  return (
    <article className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/50 p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="relative">
        <div className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
          <FileText className="size-3.5" />
          Summary
          {meta.length > 0 && (
            <span className="font-normal text-muted-foreground/70">· {meta.join(' · ')}</span>
          )}
        </div>

        {summary.summary && (
          <p className="mt-3 text-[15px] leading-[1.8] text-foreground/90">{summary.summary}</p>
        )}

        {summary.setting && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-muted/40 px-3.5 py-2.5 text-[13px] leading-relaxed">
            <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-foreground/80">{summary.setting}</span>
          </div>
        )}

        {summary.key_points.length > 0 && (
          <div className="mt-5">
            <h4 className="mb-2 text-[12px] font-medium text-muted-foreground">Highlights</h4>
            <ul className="grid gap-2 sm:grid-cols-2">
              {summary.key_points.map((point, index) => (
                <li
                  key={index}
                  className="flex gap-2.5 rounded-xl border border-border/50 px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground/85"
                >
                  <Sparkles className="mt-1 size-3 shrink-0 text-primary/80" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary.topics.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {summary.topics.map((topic) => (
              <span
                key={topic}
                className="rounded-full bg-muted/70 px-2.5 py-1 text-[12px] text-foreground/80"
              >
                {topic}
              </span>
            ))}
          </div>
        )}

        {sections.length > 0 && (
          <div className="mt-6 border-t border-border/50 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
                <ListTree className="size-3.5" />
                Section summaries
              </div>
              {summary.tiers.length > 1 && (
                <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
                  {summary.tiers.map((level, index) => (
                    <button
                      key={`${level.level}-${index}`}
                      type="button"
                      onClick={() => setTier(index)}
                      className={cn(
                        'rounded-md px-2 py-0.5 text-[11px] tabular-nums transition-colors',
                        tier === index
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {level.section_count} part{level.section_count === 1 ? '' : 's'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <ol className="mt-3 space-y-3">
              {sections.map((section, index) => (
                <li key={index} className="flex gap-3">
                  <TimeLink
                    seconds={section.start}
                    onSeek={onSeek}
                    className="mt-0.5 h-fit shrink-0 font-medium"
                  />
                  <div className="min-w-0">
                    <p className="text-[13px] leading-relaxed text-foreground/85">
                      {section.summary}
                    </p>
                    {section.chunk_ids.length > 0 && (
                      <button
                        type="button"
                        onClick={() => onOpenChunk(section.chunk_ids[0])}
                        className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        {section.chunk_ids.length} chunk
                        {section.chunk_ids.length === 1 ? '' : 's'} →
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </article>
  )
}

// ------------------------------------------------------------------ at a glance

function AtAGlance({
  stats,
  coverage,
  events,
  length,
}: {
  stats: StatsAggregate
  coverage: CoverageAggregate | null
  events: number
  length: number
}) {
  const span = stats.chunk_span
  const tiles: { label: string; value: React.ReactNode; hint?: string }[] = [
    {
      label: 'Duration',
      value: formatDuration(stats.duration || length),
      hint: stats.policy ? `${stats.policy} chunking` : undefined,
    },
    {
      label: 'Chunks',
      value: stats.chunks || '—',
      hint: span
        ? span.max - span.min < 0.5
          ? `${span.median.toFixed(1)}s each`
          : `${span.min.toFixed(0)}–${span.max.toFixed(0)}s each`
        : undefined,
    },
  ]

  if (stats.frames_sampled) {
    tiles.push({
      label: 'Frames sampled',
      value: stats.frames_sampled,
      hint: stats.by_sampler.length
        ? stats.by_sampler.map((s) => `${s.count} ${s.name}`).join(' · ')
        : undefined,
    })
  }

  tiles.push(
    stats.words
      ? {
          label: 'Speech',
          value: stats.words.toLocaleString(),
          hint: `words · ${
            stats.words_per_minute || Math.round(stats.words / Math.max(1, length / 60))
          } per min`,
        }
      : { label: 'Speech', value: 'None', hint: 'no words transcribed' }
  )

  if (coverage) {
    const total = coverage.both + coverage.picture_only + coverage.sound_only + coverage.neither
    tiles.push({
      label: 'Coverage',
      value: total ? `${Math.round(((total - coverage.neither) / total) * 100)}%` : '—',
      hint: [
        coverage.both && `${coverage.both} picture + sound`,
        coverage.picture_only && `${coverage.picture_only} picture only`,
        coverage.sound_only && `${coverage.sound_only} sound only`,
        coverage.neither && `${coverage.neither} empty`,
      ]
        .filter(Boolean)
        .join(' · '),
    })
  } else if (events) {
    tiles.push({ label: 'Events', value: events })
  }

  const people = stats.people
  const common = counted(stats.objects.most_common)

  return (
    <section className="rounded-2xl border border-border/60 bg-card/50 p-5">
      <div className="mb-4 flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
        <Gauge className="size-3.5" />
        At a glance
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="min-w-0">
            <div className="text-[12px] text-muted-foreground">{tile.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
              {tile.value}
            </div>
            {tile.hint && (
              <div className="mt-0.5 truncate text-[11.5px] text-muted-foreground/80">
                {tile.hint}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Old core statistics, still shown when present. */}
      {Object.keys(people).length > 0 && (
        <p className="mt-5 border-t border-border/50 pt-4 text-[13px] text-muted-foreground">
          {num(people.mean).toFixed(1)} people per chunk on average ({num(people.min)}–
          {num(people.max)}), {num(people.total_observations)} sightings in all.
        </p>
      )}
      {common.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-border/50 pt-4">
          {common.map((object) => (
            <li key={object.name} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-[12.5px]">{object.name}</span>
              <ShareBar value={object.count / common[0].count} />
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {object.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ chapters

const CHAPTER_TONES = [
  'bg-sky-400/80',
  'bg-violet-400/80',
  'bg-emerald-400/80',
  'bg-amber-400/80',
  'bg-rose-400/80',
  'bg-teal-400/80',
]

function ChaptersSection({
  chapters,
  duration,
  onSeek,
  onOpenChunk,
}: {
  chapters: ReturnType<typeof readChapters>
  duration: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}) {
  const total = duration || chapters.at(-1)?.end || 1

  return (
    <Section title="Chapters" icon={<BookOpen />} count={chapters.length}>
      {/* The video split by chapter, to scale. */}
      <div className="mb-4 flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
        {chapters.map((chapter, index) => (
          <button
            key={index}
            type="button"
            title={chapter.title}
            onClick={() => onSeek(chapter.start)}
            className={cn(
              'h-full transition-opacity hover:opacity-70',
              CHAPTER_TONES[index % CHAPTER_TONES.length]
            )}
            style={{ width: `${((chapter.end - chapter.start) / total) * 100}%` }}
          />
        ))}
      </div>

      <ol className="-mx-3 space-y-0.5">
        {chapters.map((chapter, index) => (
          <li
            key={`${chapter.start}-${index}`}
            className="group flex gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-muted/40"
          >
            <span
              className={cn(
                'mt-1.5 size-2.5 shrink-0 rounded-full',
                CHAPTER_TONES[index % CHAPTER_TONES.length]
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <button
                  type="button"
                  onClick={() => onSeek(chapter.start)}
                  className="text-left text-[14px] font-medium tracking-tight hover:underline hover:underline-offset-4"
                >
                  {chapter.title}
                </button>
                <TimeLink seconds={chapter.start} end={chapter.end} onSeek={onSeek} />
              </div>
              {chapter.summary && (
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {chapter.summary}
                </p>
              )}
            </div>
            {chapter.chunk_ids.length > 0 && (
              <button
                type="button"
                onClick={() => onOpenChunk(chapter.chunk_ids[0])}
                className="h-fit shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                {chapter.chunk_ids.length} chunks →
              </button>
            )}
          </li>
        ))}
      </ol>
    </Section>
  )
}

// ------------------------------------------------------------------ events

function EventsSection({
  events,
  onSeek,
  onOpenChunk,
}: {
  events: ReturnType<typeof readEvents>
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}) {
  const categories = [...new Set(events.map((event) => event.category).filter(Boolean))]
  const [category, setCategory] = useState<string | null>(null)
  const shown = category ? events.filter((event) => event.category === category) : events

  return (
    <Section
      title="Events"
      icon={<Zap />}
      count={events.length}
      actions={
        categories.length > 1 ? (
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {[null, ...categories].map((value) => (
              <button
                key={value ?? 'all'}
                type="button"
                onClick={() => setCategory(value)}
                className={cn(
                  'rounded-md px-2 py-0.5 text-[11px] capitalize transition-colors',
                  category === value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {value ?? 'All'}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <ol className="relative ml-1.5 border-l border-border/70">
        {shown.map((event, index) => (
          <li key={`${event.start}-${index}`} className="relative pb-5 pl-5 last:pb-0">
            <span className="absolute -left-[4.5px] top-[7px] size-2 rounded-full bg-foreground/50 ring-4 ring-card" />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <TimeLink seconds={event.start} onSeek={onSeek} className="font-medium" />
              {event.category && (
                <span className="rounded-full border border-border/70 px-2 py-px text-[10.5px] capitalize text-muted-foreground">
                  {event.category}
                </span>
              )}
              {event.chunk_id >= 0 && (
                <button
                  type="button"
                  onClick={() => onOpenChunk(event.chunk_id)}
                  className="text-[11px] text-muted-foreground/70 hover:text-foreground"
                >
                  chunk {event.chunk_id} →
                </button>
              )}
            </div>
            <p className="mt-1 text-[13.5px] leading-relaxed text-foreground/85">
              {sentenceCase(event.event)}
            </p>
            {event.actor && <p className="text-[12px] text-muted-foreground">by {event.actor}</p>}
          </li>
        ))}
      </ol>
    </Section>
  )
}

// ------------------------------------------------------------------ tone

function ToneSection({
  sentiment,
  duration,
  onSeek,
}: {
  sentiment: SentimentAggregate
  duration: number
  onSeek: (seconds: number) => void
}) {
  const total = duration || sentiment.points.at(-1)?.end || 1
  const scored =
    sentiment.positive + sentiment.negative + sentiment.neutral || sentiment.points.length

  return (
    <Section title="Tone" icon={<TrendingUp />} subtitle={sentiment.model}>
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Positive', value: sentiment.positive, tone: 'bg-emerald-400' },
          { label: 'Negative', value: sentiment.negative, tone: 'bg-rose-400' },
          {
            label: 'Mean score',
            value: sentiment.mean !== null ? sentiment.mean.toFixed(2) : '—',
            tone: '',
          },
        ].map((tile) => (
          <div key={tile.label}>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              {tile.tone && <span className={cn('size-1.5 rounded-full', tile.tone)} />}
              {tile.label}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight">
              {tile.value}
              {tile.tone && scored > 0 && (
                <span className="ml-1 text-[12px] font-normal text-muted-foreground">
                  of {scored}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Score per chunk around a zero line: up is positive, down negative. */}
      <div className="relative mt-5 h-20 w-full rounded-xl bg-muted/30">
        <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
        {sentiment.points.map((point, index) => {
          const left = (point.start / total) * 100
          const width = Math.max(0.6, ((point.end - point.start) / total) * 100)
          const height = Math.min(1, Math.abs(point.signed)) * 50
          const turning = sentiment.turning_points.includes(point.chunk_id)
          return (
            <button
              key={index}
              type="button"
              onClick={() => onSeek(point.start)}
              title={`${formatTimestamp(point.start)} · ${point.label} ${point.signed.toFixed(2)}`}
              className="group absolute inset-y-0"
              style={{ left: `${left}%`, width: `${width}%` }}
            >
              <span
                className={cn(
                  'absolute inset-x-[2px] rounded-sm opacity-70 transition-opacity group-hover:opacity-100',
                  point.signed >= 0 ? 'bottom-1/2 bg-emerald-400' : 'top-1/2 bg-rose-400'
                )}
                style={{ height: `${height}%` }}
              />
              {turning && (
                <span className="absolute left-1/2 top-1.5 size-1.5 -translate-x-1/2 rounded-full bg-foreground" />
              )}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        One bar per chunk; dots mark turning points. Scored by a text classifier, so it reflects the
        wording of the descriptions or speech rather than the mood of the footage.
      </p>
    </Section>
  )
}

// ------------------------------------------------------------------ named entities

function NamedEntitiesSection({
  groups,
  onOpenChunk,
}: {
  groups: ReturnType<typeof readNamedEntities>
  onOpenChunk: (chunkId: number) => void
}) {
  const total = groups.reduce((sum, group) => sum + group.entities.length, 0)

  return (
    <Section title="Named entities" icon={<Tag />} count={total}>
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.label}>
            <h4 className="mb-2 flex items-center gap-2 text-[12px] font-medium capitalize text-muted-foreground">
              {group.label}
              <span className="font-normal tabular-nums text-muted-foreground/60">
                {group.entities.length}
              </span>
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {group.entities.map((entity) => (
                <button
                  key={entity.text}
                  type="button"
                  disabled={!entity.chunk_ids.length}
                  onClick={() => onOpenChunk(entity.chunk_ids[0])}
                  title={
                    entity.chunk_ids.length ? `In chunks ${entity.chunk_ids.join(', ')}` : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/70 py-0.5 pl-2.5 pr-1 text-[12px] text-foreground/85 transition-colors enabled:hover:bg-muted/50"
                >
                  {entity.text}
                  <span className="rounded-full bg-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                    {entity.mentions}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ novelty (old core)

function NoveltySection({
  novelty,
  onSeek,
}: {
  novelty: Record<string, any>
  onSeek: (seconds: number) => void
}) {
  const ranked = asArray(novelty.ranked)
  const outliers = asArray(novelty.outliers)
  const top = ranked.slice(0, 10)
  const highest = num(asRecord(top[0]).novelty, 1)

  return (
    <Section
      title="Unusual moments"
      icon={<Layers />}
      subtitle={`ranked against ${str(novelty.basis) || 'the video'}`}
    >
      {top.length === 0 ? (
        <EmptyNote>Too few chunks for &ldquo;unlike the rest&rdquo; to mean anything.</EmptyNote>
      ) : (
        <ul className="space-y-1">
          {top.map((row, index) => {
            const entry = asRecord(row)
            const isOutlier = outliers.some(
              (outlier) => num(asRecord(outlier).chunk_id) === num(entry.chunk_id)
            )
            return (
              <li key={index} className="rounded-xl px-3 py-2.5 hover:bg-muted/30">
                <div className="flex items-center gap-2">
                  <TimeLink
                    seconds={num(entry.start)}
                    end={num(entry.end)}
                    onSeek={onSeek}
                    showIcon
                    className="font-medium"
                  />
                  {isOutlier && (
                    <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      outlier
                    </span>
                  )}
                  <span className="ml-auto flex w-32 items-center gap-2">
                    <ShareBar value={num(entry.novelty) / Math.max(highest, 0.0001)} />
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {num(entry.novelty).toFixed(3)}
                    </span>
                  </span>
                </div>
                {entry.description && (
                  <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
                    {str(entry.description)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
