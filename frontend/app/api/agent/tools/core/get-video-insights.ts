import { tool } from 'ai'
import { z } from 'zod'
import { core } from '@/lib/core/client'
import { resolveScope, type VideoToolContext } from './scope'

/**
 * Video-level results, and the replacement for the old aggregate/count tool.
 *
 * Not a port: the previous pipeline could only group indexed rows by a field.
 * These are whole passes over every chunk at once, several of them LLM-written,
 * and they answer the questions retrieval structurally cannot — "how busy was
 * it", "what stands out", "what happened, in order".
 */
const AGGREGATORS = [
  'summary',
  'chapters',
  'events',
  'stats',
  'coverage',
  'ner',
  'sentiment',
  'speaker_stats',
  'entities',
  'object_entities',
  'text_entities',
] as const

const CATALOGUE = [
  '`summary` — the whole video in 150+ words, plus its recurring topics, setting and notable moments',
  '`chapters` — contiguous titled sections with a summary and time span each',
  '`events` — discrete events (action, arrival, change, speech), each pinned to a timestamp; use for "what happened, in order" and "how many times did X happen"',
  '`stats` — duration, chunk sizes, frames sampled, speech totals',
  '`coverage` — how much of the video each analysis covered; use to tell "not present" from "not analysed"',
  '`ner` — named entities in speech and on-screen text, with where each appears; use for "which brands / who is mentioned / what places"',
  '`sentiment` — tone per moment and where it turns',
  '`speaker_stats` — talk time, turns, handovers and share per speaker',
  '`entities` — people linked across the video, each with a description and a narrative of what they did',
  '`object_entities` — objects linked across the video, with where they were and how they were used',
  '`text_entities` — on-screen text linked across the video, as it most often reads and where it appears',
].join('; ')

export function createGetVideoInsightsTool(context: VideoToolContext) {
  return tool({
    description:
      'Read a video-level result — analysis over the whole video rather than a single moment. Use this instead of retrieving many moments and reasoning over them by hand: counts, summaries, chapter structure, what stands out, who talked most, which brands appear. ' +
      `Available: ${CATALOGUE}. ` +
      'Your instructions list which of these each video has under `insights`; asking for one it lacks returns what does exist instead.',
    inputSchema: z.object({
      video_id: z.string().describe('Video id'),
      insight: z
        .enum(AGGREGATORS)
        .optional()
        .describe('Which result to read. Omit to see everything this video has.'),
    }),
    execute: async ({ video_id, insight }) => {
      const { ids, note } = await resolveScope(context, [video_id])
      if (ids.length === 0) {
        return { note: note ?? `Video ${video_id} is not searchable in this project.` }
      }

      try {
        const result = await core.aggregates(ids[0], insight)

        if (insight) {
          return { video_id, insight, result: result.result }
        }
        // No specific one asked for: name what exists rather than returning
        // twelve full results, which would swamp the context for nothing.
        return {
          video_id,
          available: result.available ?? [],
          note: 'Call again with `insight` set to read one of these in full.',
        }
      } catch (error: any) {
        // Core's 400 for a missing aggregate lists what the video does have,
        // which is exactly the correction the model needs.
        return { error: error.message }
      }
    },
  })
}
