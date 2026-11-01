import { generateText, Output } from 'ai'
import { z } from 'zod'
import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'
import { myProvider } from '@/app/agent/lib/ai/providers/providers'
import { core } from '@/lib/core/client'
import { formatTimestamp } from '@/lib/core/format'
import {
  cachedSuggestions,
  suggestionBasis,
  type StoredSuggestions,
  type VideoSuggestion,
} from '@/lib/core/suggestions'
import type { ProjectVideo } from '@/lib/core/types'
import {
  readChapters,
  readEvents,
  readNamedEntities,
  readSummary,
} from '@/app/projects/[projectId]/videos/[videoId]/components/aggregate-shapes'

type Params = Promise<{ videoId: string }>

export const maxDuration = 30

/** Cheap and fast; the job is four short lines grounded in notes it is handed. */
const MODEL = 'gpt-4o-mini'

/** The aggregates worth reading. Each is fetched on its own — `entities` alone can be megabytes. */
const SOURCES = ['summary', 'chapters', 'events', 'ner'] as const

const MAX_LABEL = 48

const schema = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum(['search', 'ask', 'clip']),
        label: z.string().describe('Card text: 3–7 words, sentence case, no title, no quotes'),
        prompt: z.string().describe('The full one-sentence request sent to the assistant'),
      })
    )
    .describe('Four suggestions, mixing kinds'),
})

const SYSTEM = `You write starter prompts for a video assistant. They appear as clickable cards under a chat box, each about ONE video.

The assistant can:
- search: find moments by description and return timestamped clips
- ask: answer questions about what is seen and said
- clip: cut a section, or assemble a highlight reel

Write exactly 4 suggestions from the notes you are given:
- Ground every one in specifics from the notes — named people, objects, places, actions, topics, chapters. Prefer what is distinctive about this video over what any video has.
- Use at least one of each kind: search, ask, clip.
- label: 3–7 words, at most ${MAX_LABEL} characters, sentence case. Questions end in "?", everything else has no final punctuation. No quotes, no video title, no "this video".
- prompt: one natural sentence the user could have typed. Refer to "the video", never its title or file name.
- Never invent details the notes do not support. If the notes are thin, keep the suggestions simple rather than guessing.`

/** Core answers a single-aggregator read as `{result}`, older builds as `{aggregates: {name}}`. */
async function readAggregate(coreVideoId: string, name: string): Promise<unknown> {
  try {
    const data = await core.aggregates(coreVideoId, name)
    return data.result ?? data.aggregates?.[name] ?? null
  } catch {
    // Not stored for this video — the notes are written from whatever is.
    return null
  }
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** The analysis as compact notes. Capped section by section so long videos stay cheap. */
function writeNotes(video: ProjectVideo, aggregates: Record<string, unknown>): string | null {
  const summary = readSummary(aggregates.summary)
  const chapters = readChapters(aggregates.chapters)
  const events = readEvents(aggregates.events)
  const named = readNamedEntities(aggregates.ner)
    .flatMap((group) => group.entities.map((entity) => ({ ...entity, label: group.label })))
    .sort((a, b) => b.mentions - a.mentions)

  if (!summary && !chapters.length && !events.length) return null

  const lines = [`Title: ${video.title}`]
  if (video.duration) lines.push(`Length: ${formatTimestamp(video.duration)}`)
  if (summary?.summary) lines.push(`Summary: ${clip(summary.summary, 900)}`)
  if (summary?.setting) lines.push(`Setting: ${clip(summary.setting, 200)}`)
  if (summary?.topics.length) lines.push(`Topics: ${summary.topics.slice(0, 8).join(', ')}`)
  if (summary?.key_points.length) {
    lines.push('Key points:', ...summary.key_points.slice(0, 6).map((p) => `- ${clip(p, 160)}`))
  }
  if (chapters.length) {
    lines.push(
      'Chapters:',
      ...chapters
        .slice(0, 8)
        .map(
          (c) =>
            `- [${formatTimestamp(c.start)}] ${c.title}${c.summary ? ` — ${clip(c.summary, 120)}` : ''}`
        )
    )
  }
  if (events.length) {
    lines.push(
      'Events:',
      ...events
        .slice(0, 12)
        .map(
          (e) =>
            `- [${formatTimestamp(e.start)}] ${e.actor ? `${e.actor}: ` : ''}${clip(e.event, 120)}`
        )
    )
  }
  if (named.length) {
    lines.push(
      `Named in speech: ${named
        .slice(0, 10)
        .map((e) => `${e.text} (${e.label.toLowerCase()}, ${e.mentions}×)`)
        .join(', ')}`
    )
  }
  return lines.join('\n')
}

/** Model output, tidied: lengths enforced, blanks and duplicates dropped. */
function tidy(items: VideoSuggestion[]): VideoSuggestion[] {
  const seen = new Set<string>()
  return items
    .map((item) => ({
      kind: item.kind,
      label: item.label
        .trim()
        .replace(/^["“']|["”']$/g, '')
        .replace(/\.$/, ''),
      prompt: item.prompt.trim(),
    }))
    .filter((item) => item.label && item.prompt && item.label.length <= MAX_LABEL + 12)
    .filter((item) => !seen.has(item.label.toLowerCase()) && seen.add(item.label.toLowerCase()))
    .slice(0, 4)
}

/**
 * Starter prompts for one video.
 *
 * Written once per analysis and cached on the row: a repeat visit reads the
 * cache, and only a re-index (which changes the basis) pays for a new call.
 */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { videoId } = await params

  const user = await getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const supabase = await createSupabaseServer()
  const { data } = await supabase
    .from('video_core')
    .select('*')
    .eq('id', videoId)
    .eq('user_id', user.id)
    .single()

  if (!data) return new Response('Video not found', { status: 404 })
  const video = data as ProjectVideo

  if (video.status !== 'ready' || !video.core_video_id) {
    return new Response('This video has not finished processing', { status: 409 })
  }

  const cached = cachedSuggestions(video)
  if (cached) return Response.json({ suggestions: cached, cached: true })

  const coreVideoId = video.core_video_id
  const results = await Promise.all(SOURCES.map((name) => readAggregate(coreVideoId, name)))
  const notes = writeNotes(video, Object.fromEntries(SOURCES.map((name, i) => [name, results[i]])))

  // Nothing analysed to write from; the workspace falls back to generic prompts.
  if (!notes) return Response.json({ suggestions: [], cached: false })

  let suggestions: VideoSuggestion[]
  try {
    const { output } = await generateText({
      model: myProvider.languageModel(MODEL),
      output: Output.object({ schema }),
      system: SYSTEM,
      prompt: notes,
      temperature: 0.4,
    })
    suggestions = tidy(output?.suggestions ?? [])
  } catch (err: any) {
    return new Response(err?.message || 'Could not write suggestions', { status: 502 })
  }

  const stored: StoredSuggestions = {
    basis: suggestionBasis(video),
    items: suggestions,
    model: MODEL,
    created_at: new Date().toISOString(),
  }

  // Best effort: without the column (migration not yet run) this still answers,
  // it just answers by calling the model again next time.
  const { error } = await supabase
    .from('video_core')
    .update({ suggestions: stored })
    .eq('id', videoId)
  if (error) console.warn('[suggestions] not cached:', error.message)

  return Response.json({ suggestions, cached: false })
}
