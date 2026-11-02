import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'

type Params = Promise<{ projectId: string }>

export async function POST(
  _request: Request,
  { params }: { params: Params }
) {
  const user = await getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { projectId } = await params
  const supabase = await createSupabaseServer()

  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .single()

  if (projectError || !project || project.user_id !== user.id) {
    return new Response('Project not found', { status: 404 })
  }

  // A placeholder until the first message arrives and the agent names the chat.
  const { data: conversation, error: conversationError } = await supabase
    .from('conversations')
    .insert({
      user_id: user.id,
      project_id: projectId,
      title: 'New chat',
    })
    .select()
    .single()

  if (conversationError || !conversation) {
    return new Response(conversationError?.message || 'Failed to create conversation', { status: 500 })
  }

  return Response.json({
    conversationId: conversation.id,
    projectId,
  })
}
