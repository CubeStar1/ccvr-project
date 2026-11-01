/**
 * Starter prompts for one video, written by an LLM from its stored analysis.
 *
 * Shared by the route that writes them and the workspace that shows them, so
 * both agree on the shape and on when a cached set has gone stale.
 */

import type { ProjectVideo } from './types'

export type SuggestionKind = 'search' | 'ask' | 'clip'

export interface VideoSuggestion {
  kind: SuggestionKind
  /** Card text — a few words, never the video's title. */
  label: string
  /** The full request sent to the agent. Refers to "the video", not its title. */
  prompt: string
}

/** What `video_core.suggestions` holds. */
export interface StoredSuggestions {
  basis: string
  items: VideoSuggestion[]
  model: string
  created_at: string
}

/**
 * What the suggestions were written from. Re-indexing changes the analysis —
 * and with it this key — while a rename does not, since prompts never name the
 * video.
 */
export function suggestionBasis(
  video: Pick<ProjectVideo, 'core_video_id' | 'aggregates' | 'chunk_count'>
): string {
  return [
    video.core_video_id ?? '',
    [...(video.aggregates ?? [])].sort().join(','),
    video.chunk_count,
  ].join(':')
}

/** The row's cached set, if it still matches the analysis it was written from. */
export function cachedSuggestions(video: ProjectVideo): VideoSuggestion[] | null {
  const stored = video.suggestions
  if (!stored || stored.basis !== suggestionBasis(video) || !Array.isArray(stored.items))
    return null
  return stored.items
}
