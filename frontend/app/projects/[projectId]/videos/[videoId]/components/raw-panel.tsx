'use client'

import { useState } from 'react'
import { Check, Copy, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatDuration } from '@/lib/core/format'
import { describeChunking } from '@/lib/core/chunking'
import type { VideoDetails } from '@/lib/core/types'
import { Chips, EmptyNote, JsonView, RawDisclosure } from './detail-primitives'

/**
 * The stored record itself: the row, the backend's metadata, and every
 * aggregate in the shape it was returned.
 *
 * The other tabs read aggregates they recognise. This one reads all of them,
 * which keeps the page honest when the backend gains an aggregator the
 * frontend has never heard of.
 */
export function RawPanel({ details }: { details: VideoDetails }) {
  const { video, core, aggregates, available } = details
  const ids = [...new Set([...Object.keys(aggregates), ...available])].sort()

  const fields: { label: string; value: React.ReactNode; wide?: boolean; mono?: boolean }[] = [
    {
      label: 'Status',
      value: (
        <span className="capitalize">
          {video.status}
          {video.stage && <span className="text-muted-foreground"> · {video.stage}</span>}
        </span>
      ),
    },
    { label: 'Duration', value: formatDuration(video.duration ?? core?.duration) },
    { label: 'Size', value: formatBytes(video.size_bytes ?? core?.size_bytes) },
    { label: 'Chunks', value: details.chunk_total || video.chunk_count || 0 },
    {
      label: 'Chunking',
      value: <span className="capitalize">{video.chunk_config || core?.chunk_config || '—'}</span>,
    },
    { label: 'Source', value: <span className="capitalize">{video.source_type}</span> },
    { label: 'Created', value: new Date(video.created_at).toLocaleString() },
    { label: 'Updated', value: new Date(video.updated_at).toLocaleString() },
    { label: 'Core video id', value: video.core_video_id ?? '—', mono: true },
    { label: 'Job', value: video.job_id ?? '—', mono: true },
    {
      label: 'Storage path',
      value: video.storage_path ?? core?.storage_path ?? '—',
      mono: true,
      wide: true,
    },
  ]

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border/60 bg-card/50 p-5">
        <div className="mb-4 flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
            <Database className="size-3.5" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-medium tracking-tight">{video.title}</h3>
            {video.ingest_config && (
              <p className="truncate text-[12px] text-muted-foreground">
                {describeChunking(video.ingest_config)}
              </p>
            )}
          </div>
        </div>

        <dl className="grid gap-px overflow-hidden rounded-xl bg-border/50 sm:grid-cols-2 xl:grid-cols-3">
          {fields.map((field) => (
            <div
              key={field.label}
              className={cn(
                'min-w-0 bg-card px-3.5 py-3',
                field.wide && 'sm:col-span-2 xl:col-span-3'
              )}
            >
              <dt className="text-[11.5px] text-muted-foreground">{field.label}</dt>
              <dd
                className={cn(
                  'mt-0.5 truncate text-[13px]',
                  field.mono && 'font-mono text-[12px] text-foreground/80'
                )}
                title={typeof field.value === 'string' ? field.value : undefined}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-4">
          <div className="mb-1.5 text-[12px] text-muted-foreground">Analyzers</div>
          <Chips items={core?.analyzers ?? video.analyzers ?? []} tone="outline" />
        </div>

        {video.error && (
          <p className="mt-4 rounded-xl bg-red-500/10 px-3.5 py-2.5 text-[12.5px] text-red-600 dark:text-red-400">
            {video.error}
          </p>
        )}

        {core?.params && Object.keys(core.params).length > 0 && (
          <div className="mt-4 border-t border-border/50 pt-4">
            <div className="mb-2 text-[12px] text-muted-foreground">Chunking parameters</div>
            <JsonView value={core.params} />
          </div>
        )}

        <RawDisclosure label="Raw row and metadata" value={{ video, core }} />
      </section>

      <AggregateBrowser ids={ids} aggregates={aggregates} />
    </div>
  )
}

/** Every stored aggregate: pick one on the left, read it on the right. */
function AggregateBrowser({
  ids,
  aggregates,
}: {
  ids: string[]
  aggregates: Record<string, unknown>
}) {
  const [selected, setSelected] = useState(ids[0] ?? '')
  const [mode, setMode] = useState<'tree' | 'json'>('tree')
  const [copied, setCopied] = useState(false)
  const value = aggregates[selected] ?? null
  const json = JSON.stringify(value, null, 2)

  if (ids.length === 0) {
    return (
      <section className="rounded-2xl border border-border/60 bg-card/50 p-5">
        <EmptyNote>
          No aggregates stored. They run after analysis, and any whose analyzer was not selected is
          skipped rather than failed.
        </EmptyNote>
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card/50">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-5 py-3.5">
        <h3 className="text-[14px] font-medium tracking-tight">
          Aggregates{' '}
          <span className="font-normal tabular-nums text-muted-foreground">{ids.length}</span>
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {(['tree', 'json'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                className={cn(
                  'rounded-md px-2.5 py-0.5 text-[11.5px] transition-colors',
                  mode === option
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {option === 'tree' ? 'Readable' : 'JSON'}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="Copy JSON"
            onClick={() => {
              void navigator.clipboard?.writeText(json)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            }}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 p-2 md:w-52 md:flex-col md:border-b-0 md:border-r">
          {ids.map((id) => {
            const stored = id in aggregates
            const size = stored ? JSON.stringify(aggregates[id]).length : 0
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSelected(id)}
                className={cn(
                  'flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors',
                  selected === id
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <span className="truncate font-mono">{id}</span>
                <span className="text-[10.5px] tabular-nums text-muted-foreground/70">
                  {stored ? formatBytes(size) : 'empty'}
                </span>
              </button>
            )
          })}
        </nav>

        <div className="min-w-0 flex-1 p-5">
          {mode === 'tree' ? (
            <div className="max-h-[70vh] overflow-auto">
              <JsonView value={value} />
            </div>
          ) : (
            <pre className="max-h-[70vh] overflow-auto rounded-xl bg-muted/40 p-4 font-mono text-[11.5px] leading-relaxed text-foreground/80">
              {json}
            </pre>
          )}
        </div>
      </div>
    </section>
  )
}
