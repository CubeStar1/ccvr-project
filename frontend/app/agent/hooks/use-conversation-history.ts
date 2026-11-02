'use client'

import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ProjectHistoryItem } from '@/app/agent/types'

/** Prefix of the sidebar's project/conversation history query. */
export const CONVERSATION_HISTORY_KEY = ['agent-project-history'] as const

/**
 * The sidebar lives in a layout, so it never remounts on navigation and won't
 * refetch by itself. Anything that changes a conversation tells it here.
 */
export function useConversationHistory() {
  const queryClient = useQueryClient()

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: CONVERSATION_HISTORY_KEY }),
    [queryClient]
  )

  /** Show a new title straight away, without waiting on a refetch. */
  const setTitle = useCallback(
    (conversationId: string, title: string) => {
      queryClient.setQueriesData<ProjectHistoryItem[]>(
        { queryKey: CONVERSATION_HISTORY_KEY },
        (items) =>
          items?.map((item) => ({
            ...item,
            conversations: item.conversations.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, title } : conversation
            ),
          }))
      )
    },
    [queryClient]
  )

  return { refresh, setTitle }
}
