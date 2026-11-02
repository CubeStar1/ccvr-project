'use client'

import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CONVERSATION_HISTORY_KEY } from '@/app/agent/hooks/use-conversation-history'
import type { Project } from '@/app/agent/types'

export type ProjectSummary = Pick<Project, 'id' | 'name'>

export const PROJECTS_KEY = ['projects'] as const

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: async () => {
      const response = await fetch('/api/projects')
      if (!response.ok) throw new Error(await response.text())
      const { projects } = await response.json()
      return projects as ProjectSummary[]
    },
  })
}

export function useRenameProject() {
  const router = useRouter()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ projectId, name }: { projectId: string; name: string }) => {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!response.ok) throw new Error(await response.text())
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
      queryClient.invalidateQueries({ queryKey: CONVERSATION_HISTORY_KEY })
      router.refresh()
    },
  })
}
