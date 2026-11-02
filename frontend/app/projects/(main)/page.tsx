import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'
import { ProjectsPageClient } from './projects-page-client'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const user = await getUser()
  const supabase = await createSupabaseServer()

  const [{ data: projects }, { data: conversations }, { data: videos }] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, description, updated_at')
      .eq('user_id', user!.id)
      .order('updated_at', { ascending: false }),
    supabase
      .from('conversations')
      .select('id, title, project_id, updated_at')
      .eq('user_id', user!.id)
      .not('project_id', 'is', null)
      .order('updated_at', { ascending: false }),
    supabase
      .from('video_core')
      .select('id, project_id, poster_url, duration, status')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false }),
  ])

  return (
    <ProjectsPageClient
      userName={user!.user_metadata?.full_name ?? user!.user_metadata?.name ?? null}
      projects={projects ?? []}
      conversations={conversations ?? []}
      videos={videos ?? []}
    />
  )
}
