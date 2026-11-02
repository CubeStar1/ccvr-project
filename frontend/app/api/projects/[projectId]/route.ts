import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'

type Params = Promise<{ projectId: string }>

const MAX_NAME = 100

export async function PATCH(request: Request, { params }: { params: Params }) {
  const user = await getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const body = await request.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.replace(/\s+/g, ' ').trim() : ''
  if (!name) return new Response('Name cannot be empty', { status: 400 })
  if (name.length > MAX_NAME) {
    return new Response(`Name must be ${MAX_NAME} characters or fewer`, { status: 400 })
  }

  const { projectId } = await params
  const supabase = await createSupabaseServer()
  const { data: project, error } = await supabase
    .from('projects')
    .update({ name })
    .eq('id', projectId)
    .eq('user_id', user.id)
    .select()
    .maybeSingle()

  if (error) return new Response(error.message, { status: 500 })
  if (!project) return new Response('Project not found', { status: 404 })

  return Response.json({ project })
}
