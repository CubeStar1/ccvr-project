'use client'

import { useMemo } from 'react'
import { Captions, MessagesSquare, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/lib/core/format'
import type { ChunkOut } from '@/lib/core/types'
import { EmptyNote, Section, ShareBar, TimeLink } from './detail-primitives'
import { readSpeakers, readSpeakerTotals, speakerLabel } from './aggregate-shapes'

interface SpeechPanelProps {
  chunks: ChunkOut[]
  aggregates: Record<string, unknown>
  currentTime: number
  onSeek: (seconds: number) => void
  onOpenChunk: (chunkId: number) => void
}

interface Line {
  start: number
  end: number
  text: string
  speaker?: string
  chunk_id: number
}

/**
 * Everything spoken, and who spoke it.
 *
 * The transcript is rebuilt from the chunks rather than fetched: `diarization`
 * and `transcript` are mutually exclusive at ingest, so at most one of them put
 * anything on a chunk, and whichever it was is already here.
 */
export function SpeechPanel({
  chunks,
  aggregates,
  currentTime,
  onSeek,
  onOpenChunk,
}: SpeechPanelProps) {
  const lines = useMemo<Line[]>(() => {
    const collected: Line[] = []
    for (const chunk of chunks) {
      for (const turn of chunk.diarization?.turns ?? []) {
        if (turn.text?.trim()) {
          collected.push({
            start: turn.start,
            end: turn.end,
            text: turn.text.trim(),
            speaker: turn.speaker,
            chunk_id: chunk.chunk_id,
          })
        }
      }
      const plain = chunk.transcript?.text?.trim()
      if (plain) {
        collected.push({
          start: chunk.start,
          end: chunk.end,
          text: plain,
          chunk_id: chunk.chunk_id,
        })
      }
    }
    return collected.sort((a, b) => a.start - b.start)
  }, [chunks])

  const speakers = readSpeakers(aggregates.speaker_stats)
  const totals = readSpeakerTotals(aggregates.speaker_stats)

  if (lines.length === 0 && speakers.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border/60 py-16 text-center">
        <Captions className="mx-auto size-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm font-medium">No speech</p>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
          Either this video has no audible speech, or it was analysed without the{' '}
          <code className="text-[12px]">transcript</code> or{' '}
          <code className="text-[12px]">diarization</code> pass.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {speakers.length > 0 && (
        <Section
          title="Speakers"
          icon={<Mic />}
          count={totals.count || speakers.length}
          subtitle={[
            totals.turns && `${totals.turns} turns`,
            totals.handovers && `${totals.handovers} handovers`,
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <div className="mb-5 grid grid-cols-3 gap-4">
            {[
              {
                label: 'Total speech',
                value: formatDuration(totals.speech_seconds),
                hint:
                  totals.speech_ratio !== null
                    ? `${Math.round(totals.speech_ratio * 100)}% of runtime`
                    : undefined,
              },
              { label: 'Turns', value: totals.turns || '—' },
              {
                label: 'Dominant',
                value: totals.dominant ? speakerLabel(totals.dominant) : '—',
                hint: 'most talk time',
              },
            ].map((tile) => (
              <div key={tile.label}>
                <div className="text-[12px] text-muted-foreground">{tile.label}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight">
                  {tile.value}
                </div>
                {tile.hint && (
                  <div className="text-[11.5px] text-muted-foreground/80">{tile.hint}</div>
                )}
              </div>
            ))}
          </div>

          <ul className="space-y-3">
            {speakers.map((speaker) => (
              <li key={speaker.speaker}>
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] font-medium">{speakerLabel(speaker.speaker)}</span>
                  <span className="ml-auto text-[12px] tabular-nums text-muted-foreground">
                    {Math.round(speaker.share * 100)}% · {formatDuration(speaker.seconds)}
                  </span>
                </div>
                <ShareBar value={speaker.share} className="mt-1.5" />
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                  {speaker.turns > 0 && <span>{speaker.turns} turns</span>}
                  {speaker.words > 0 && <span>{speaker.words} words</span>}
                  {speaker.words_per_second > 0 && (
                    <span>{speaker.words_per_second.toFixed(1)} words/s</span>
                  )}
                  {speaker.longest_turn > 0 && (
                    <span>longest turn {formatDuration(speaker.longest_turn)}</span>
                  )}
                  {speaker.last_seen > 0 && (
                    <span>
                      <TimeLink seconds={speaker.first_seen} onSeek={onSeek} /> –{' '}
                      <TimeLink seconds={speaker.last_seen} onSeek={onSeek} />
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Transcript"
        icon={<MessagesSquare />}
        count={lines.length}
        subtitle={
          lines.some((line) => line.speaker)
            ? 'speaker-attributed (diarization)'
            : 'plain speech (transcript)'
        }
      >
        {lines.length === 0 ? (
          <EmptyNote>No speech was transcribed on any chunk.</EmptyNote>
        ) : (
          <ul className="space-y-0.5">
            {lines.map((line, index) => {
              const isActive = currentTime >= line.start && currentTime < line.end
              return (
                <li
                  key={`${line.start}-${index}`}
                  className={cn(
                    'flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors',
                    isActive ? 'bg-muted/60' : 'hover:bg-muted/30'
                  )}
                >
                  <TimeLink seconds={line.start} onSeek={onSeek} className="mt-0.5 shrink-0" />
                  {line.speaker && (
                    <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {line.speaker.replace(/^SPEAKER_/, 'S')}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-[13px] leading-snug">{line.text}</span>
                  <button
                    type="button"
                    onClick={() => onOpenChunk(line.chunk_id)}
                    className="mt-0.5 shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                  >
                    {line.chunk_id}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
