'use client'

import { useState } from 'react'
import { Film, MessageSquare, Scissors, Search } from 'lucide-react'
import { useVideoSuggestions } from '@/hooks/use-video-suggestions'
import type { SuggestionKind, VideoSuggestion } from '@/lib/core/suggestions'
import type { ProjectVideo } from '@/lib/core/types'

export interface Suggestion {
  kind: SuggestionKind
  /** What the card shows — short, because the card's poster already says which video. */
  label: string
  /** What goes into the prompt box. */
  text: string
  /** The videos it is about; picking it scopes the chat to them. */
  videoIds: string[]
}

const KINDS: Record<SuggestionKind, { icon: typeof Search; name: string }> = {
  search: { icon: Search, name: 'Search' },
  ask: { icon: MessageSquare, name: 'Ask' },
  clip: { icon: Scissors, name: 'Clip' },
}

const MAX_SUGGESTIONS = 6

/** For a video the model had nothing to write from, or whose request failed. */
const GENERIC: VideoSuggestion[] = [
  { kind: 'ask', label: 'Summarize what happens', prompt: 'Summarize what happens in the video' },
  {
    kind: 'clip',
    label: 'Cut a highlight reel',
    prompt: 'Cut a highlight reel of the key moments in the video',
  },
]

/** Round-robin across videos so one video does not crowd out the rest. */
function interleave(lists: Suggestion[][]): Suggestion[] {
  const merged: Suggestion[] = []
  const longest = Math.max(0, ...lists.map((list) => list.length))
  for (let index = 0; index < longest; index++) {
    for (const list of lists) if (list[index]) merged.push(list[index])
  }
  return merged
}

export function buildSuggestions(
  videos: ProjectVideo[],
  written: Map<string, VideoSuggestion[]>
): Suggestion[] {
  if (videos.length === 0) return []

  // Prompts say "the video" rather than naming it; picking one scopes the chat
  // to that video, which is what makes "the video" unambiguous.
  const lists = videos.map((video) =>
    (written.get(video.id) ?? GENERIC).map((item) => ({
      kind: item.kind,
      label: item.label,
      text: item.prompt,
      videoIds: [video.id],
    }))
  )

  const merged = interleave(lists)
  if (videos.length > 1) {
    merged.splice(2, 0, {
      kind: 'ask',
      label: videos.length === 2 ? 'Compare the two videos' : 'Compare these videos',
      text: 'Compare these videos — what does each one cover, and how do they differ?',
      videoIds: videos.map((video) => video.id),
    })
  }

  const seen = new Set<string>()
  return merged
    .filter((item) => {
      const key = `${item.videoIds.join()}|${item.label.toLowerCase()}`
      return seen.has(key) ? false : (seen.add(key), true)
    })
    .slice(0, MAX_SUGGESTIONS)
}

interface PromptSuggestionsProps {
  /** The videos a prompt would cover right now: the tagged ones, or the whole library. */
  videos: ProjectVideo[]
  libraryCount: number
  onSelect: (suggestion: Suggestion) => void
}

export function PromptSuggestions({ videos, libraryCount, onSelect }: PromptSuggestionsProps) {
  const summaries = useVideoSuggestions(videos)
  const suggestions = buildSuggestions(summaries.videos, summaries.suggestions)
  const byId = new Map(summaries.videos.map((video) => [video.id, video]))

  if (summaries.videos.length === 0) return null

  return (
    <div>
      <p className="mb-2.5 px-1 text-xs font-medium text-muted-foreground">Suggestions</p>

      <div className="grid gap-2 sm:grid-cols-2">
        {summaries.isLoading
          ? Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 rounded-xl border p-2">
                <div className="h-9 w-14 shrink-0 animate-pulse rounded-md bg-muted" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 w-10 animate-pulse rounded bg-muted" />
                  <div
                    className="h-3 animate-pulse rounded bg-muted"
                    style={{ width: `${60 + ((index * 13) % 30)}%` }}
                  />
                </div>
              </div>
            ))
          : suggestions.map((suggestion) => {
              const { icon: Icon, name } = KINDS[suggestion.kind]
              const covered = suggestion.videoIds
                .map((id) => byId.get(id))
                .filter((video): video is ProjectVideo => Boolean(video))
              return (
                <button
                  key={`${suggestion.videoIds.join()}|${suggestion.label}`}
                  type="button"
                  onClick={() => onSelect(suggestion)}
                  title={suggestion.text}
                  className="group flex min-w-0 items-center gap-3 rounded-xl border bg-card/40 p-2 text-left transition-colors hover:border-foreground/20 hover:bg-muted/60"
                >
                  <Thumbs videos={covered} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                      <Icon className="size-3 shrink-0" />
                      {name}
                      {covered.length === 1 && libraryCount > 1 && (
                        <span className="truncate text-muted-foreground/70">
                          · {covered[0].title}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-foreground/85 group-hover:text-foreground">
                      {suggestion.label}
                    </span>
                  </span>
                </button>
              )
            })}
      </div>
    </div>
  )
}

/** The poster of the video a suggestion is about — two overlapped when it spans several. */
function Thumbs({ videos }: { videos: ProjectVideo[] }) {
  const shown = videos.slice(0, 2)
  if (shown.length === 0) return null

  return (
    <span className="relative h-9 w-14 shrink-0">
      {shown.map((video, index) => (
        <Poster
          key={video.id}
          video={video}
          className={
            shown.length === 1
              ? 'inset-0 size-full'
              : index === 0
                ? 'left-0 top-0 h-7 w-11'
                : 'bottom-0 right-0 h-7 w-11 ring-2 ring-card'
          }
        />
      ))}
    </span>
  )
}

function Poster({ video, className }: { video: ProjectVideo; className: string }) {
  const [failed, setFailed] = useState(false)
  const base = `absolute overflow-hidden rounded-md bg-muted ${className}`

  if (!video.poster_url || failed) {
    return (
      <span className={`${base} flex items-center justify-center`}>
        <Film className="size-3.5 text-muted-foreground/60" />
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- posters live in core's bucket
    <img
      src={video.poster_url}
      alt=""
      onError={() => setFailed(true)}
      className={`${base} object-cover`}
    />
  )
}
