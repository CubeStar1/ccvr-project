'use client'

import { useQueries } from '@tanstack/react-query'
import { cachedSuggestions, suggestionBasis, type VideoSuggestion } from '@/lib/core/suggestions'
import type { ProjectVideo } from '@/lib/core/types'

/** Enough variety for a handful of cards without a model call per video in a large library. */
const MAX_VIDEOS = 4

async function fetchSuggestions(videoId: string): Promise<VideoSuggestion[]> {
  const response = await fetch(`/api/videos/${videoId}/suggestions`)
  if (!response.ok) throw new Error(await response.text())
  const { suggestions } = await response.json()
  return suggestions ?? []
}

/**
 * LLM-written starter prompts for the videos a prompt would cover, by video id.
 *
 * A row that already carries a fresh set is used as-is — no request at all.
 * Otherwise the route writes one (a model call, once per analysis) and caches
 * it on the row. Videos whose request fails are simply absent.
 */
export function useVideoSuggestions(videos: ProjectVideo[]) {
  const scope = videos.filter((video) => video.status === 'ready').slice(0, MAX_VIDEOS)

  const results = useQueries({
    queries: scope.map((video) => {
      const cached = cachedSuggestions(video)
      return {
        queryKey: ['video-suggestions', video.id, suggestionBasis(video)],
        queryFn: () => fetchSuggestions(video.id),
        initialData: cached ?? undefined,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
      }
    }),
  })

  const byVideo = new Map<string, VideoSuggestion[]>()
  scope.forEach((video, index) => {
    const data = results[index]?.data
    if (data?.length) byVideo.set(video.id, data)
  })

  return {
    videos: scope,
    suggestions: byVideo,
    isLoading: results.some((result) => result.isLoading),
  }
}
