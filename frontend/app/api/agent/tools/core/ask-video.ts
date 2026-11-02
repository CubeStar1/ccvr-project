import { tool } from 'ai'
import { z } from 'zod'
import { core } from '@/lib/core/client'
import { formatRange } from '@/lib/core/format'
import { resolveScope, titleMap, urlMap, type VideoToolContext } from './scope'

export function createAskVideoTool(context: VideoToolContext) {
  return tool({
    description:
      'Ask a question about the project\'s videos and get a written answer plus the source moments it drew on. ' +
      'It reads each video\'s summary and chapters (first five videos in scope) together with the moments that best match the question, so it is strongest on "what / why / how / summarize" questions that need both the overall picture and specific evidence. ' +
      'It does not read counts, events, named entities, people tracking or speaker statistics — for those, read the matching result with get_video_insights or get_video_entities. ' +
      'Its answer is itself a model\'s synthesis: rely on the timestamps in `sources`, not ones that appear only in the answer text.',
    inputSchema: z.object({
      question: z.string().describe('The question, phrased in full'),
      video_ids: z
        .array(z.string())
        .optional()
        .describe('Restrict to these video ids. Omit to answer from every searchable video.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(6)
        .describe('How many supporting segments to retrieve per video'),
    }),
    execute: async ({ question, video_ids, limit }) => {
      const { ids, videos, note } = await resolveScope(context, video_ids)
      if (ids.length === 0) return { answer: '', sources: [], note: note ?? 'Nothing analysed yet.' }

      const titles = titleMap(videos)
      const urls = urlMap(videos)

      try {
        const result = await core.ask({ question, video_ids: ids, limit })

        return {
          question,
          answer: result.answer || 'The analysis returned no answer for this question.',
          // Which video-level results core consulted, per video. Worth reporting:
          // it explains why an answer knows something no single segment says.
          consulted: result.sources,
          sources: result.results.map((hit) => ({
            video_id: hit.video_id,
            video_title: titles.get(hit.video_id),
            url: urls.get(hit.video_id),
            chunk_id: hit.chunk_id,
            timestamp: formatRange(hit.start, hit.end),
            start: hit.start,
            end: hit.end,
            text: hit.description ?? hit.snippet,
          })),
          ...(result.error ? { warning: result.error } : {}),
          ...(note ? { scope_warning: note } : {}),
        }
      } catch (error: any) {
        return { error: error.message, answer: '', sources: [] }
      }
    },
  })
}
