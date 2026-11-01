'use client'

import { useState } from 'react'
import { ChevronRight, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTimestamp } from '@/lib/core/format'
import { parseLoose } from './aggregate-shapes'

/**
 * A titled block, collapsed and expanded by its header.
 *
 * Every panel on this page is made of these. They collapse because a fully
 * analysed video produces more sections than fit on a screen — a summary, four
 * statistics blocks, chapters, events, novelty, named entities — and scrolling
 * past ones you are not reading is the thing that makes the page feel long.
 */
export function Section({
  title,
  subtitle,
  count,
  icon,
  actions,
  children,
  className,
  collapsible = true,
  defaultOpen = true,
}: {
  title: string
  subtitle?: string
  count?: number
  icon?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const isOpen = collapsible ? open : true

  const heading = (
    <>
      {icon && (
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <span className="truncate">{title}</span>
      {count !== undefined && (
        <span className="text-[12px] font-normal tabular-nums text-muted-foreground">{count}</span>
      )}
      {subtitle && (
        <span className="hidden truncate text-[12px] font-normal text-muted-foreground sm:inline">
          · {subtitle}
        </span>
      )}
      {collapsible && (
        <ChevronRight
          className={cn(
            'ml-auto size-4 shrink-0 text-muted-foreground/60 transition-transform duration-200',
            isOpen && 'rotate-90'
          )}
        />
      )}
    </>
  )

  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-[0_1px_0_0_rgb(255_255_255/0.03)_inset]',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3.5">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-[14px] font-medium tracking-tight"
          >
            {heading}
          </button>
        ) : (
          <h3 className="flex min-w-0 flex-1 items-center gap-2.5 text-[14px] font-medium tracking-tight">
            {heading}
          </h3>
        )}
        {isOpen && actions}
      </div>
      {isOpen && <div className="px-5 pb-5">{children}</div>}
    </section>
  )
}

/** Label above a value, the unit the metadata strip and stat grids are built from. */
export function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 min-w-0 text-[13px]">{children}</div>
    </div>
  )
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: React.ReactNode
  hint?: string
}) {
  return (
    <div className="rounded-xl bg-muted/40 px-3.5 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums leading-tight tracking-tight">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

/** Short labels — tags, objects, topics, roles. */
export function Chips({
  items,
  tone = 'muted',
  className,
}: {
  items: (string | null | undefined)[]
  tone?: 'muted' | 'outline' | 'accent'
  className?: string
}) {
  const values = items.filter((item): item is string => Boolean(item && String(item).trim()))
  if (values.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] leading-snug',
            tone === 'muted' && 'bg-muted/70 text-muted-foreground',
            tone === 'outline' && 'border border-border/70 text-foreground/75',
            tone === 'accent' && 'bg-primary/10 text-primary'
          )}
        >
          {value}
        </span>
      ))}
    </div>
  )
}

/** A timestamp that seeks the player above. Every time on this page is one of these. */
export function TimeLink({
  seconds,
  end,
  onSeek,
  className,
  showIcon = false,
}: {
  seconds: number
  end?: number
  onSeek?: (seconds: number) => void
  className?: string
  showIcon?: boolean
}) {
  const label =
    end !== undefined && end > seconds
      ? `${formatTimestamp(seconds)}–${formatTimestamp(end)}`
      : formatTimestamp(seconds)

  if (!onSeek) {
    return (
      <span className={cn('text-[11px] tabular-nums text-muted-foreground', className)}>
        {label}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onSeek(seconds)
      }}
      title="Play from here"
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary',
        className
      )}
    >
      {showIcon && <Play className="size-2.5 fill-current" />}
      {label}
    </button>
  )
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-muted-foreground">{children}</p>
}

/** A count and its bar, for shares that add up to something (talk time, sentiment). */
export function ShareBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted/70', className)}>
      <div
        className="h-full rounded-full bg-foreground/60"
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  )
}

/**
 * Anything this page has no hand-written renderer for.
 *
 * The point of the page is that nothing core stored is hidden, and aggregators
 * are added without the frontend knowing — so an unrecognised shape has to
 * render as *something* readable rather than being dropped.
 */
export function JsonView({ value: input, depth = 0 }: { value: unknown; depth?: number }) {
  // A JSON document stored as a string is still structure, not prose.
  const value = parseLoose(input)

  if (value === null || value === undefined) {
    return <span className="text-[12px] text-muted-foreground">—</span>
  }

  if (typeof value === 'string') {
    return (
      <span className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground/85">
        {value}
      </span>
    )
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return (
      <span className="font-mono text-[12px] tabular-nums text-foreground/85">
        {typeof value === 'number' && !Number.isInteger(value)
          ? Number(value.toFixed(4))
          : String(value)}
      </span>
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-[12px] text-muted-foreground">empty</span>
    }

    // A flat list of scalars reads far better as chips than as numbered rows.
    if (
      value.every(
        (item) =>
          (typeof item === 'string' && parseLoose(item) === item) || typeof item === 'number'
      )
    ) {
      return <Chips items={value.map(String)} tone="outline" />
    }

    // Long lists are capped; the JSON view on the Record tab has the rest.
    const shown = value.slice(0, 50)
    return (
      <ol className="space-y-2">
        {shown.map((item, index) => (
          <li
            key={index}
            className="relative rounded-xl bg-muted/30 py-2.5 pl-9 pr-3 text-[12.5px]"
          >
            <span className="absolute left-3 top-2.5 text-[10.5px] tabular-nums text-muted-foreground/70">
              {index + 1}
            </span>
            <JsonView value={item} depth={depth + 1} />
          </li>
        ))}
        {value.length > shown.length && (
          <li className="px-3 text-[11.5px] text-muted-foreground">
            + {value.length - shown.length} more
          </li>
        )}
      </ol>
    )
  }

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return <span className="text-[12px] text-muted-foreground">empty</span>
  }

  return (
    <dl className={cn('space-y-2', depth > 1 && 'border-l border-border/60 pl-3')}>
      {entries.map(([key, item]) => (
        <div key={key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
          <dt className="shrink-0 text-[11.5px] capitalize text-muted-foreground sm:w-32">
            {key.replace(/_/g, ' ')}
          </dt>
          <dd className="min-w-0 flex-1 text-[12.5px]">
            <JsonView value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Collapsed raw output, so "everything" stays true without swamping the page. */
export function RawDisclosure({ label = 'Raw output', value }: { label?: string; value: unknown }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-4 border-t border-border/50 pt-3">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      {open && (
        <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  )
}
