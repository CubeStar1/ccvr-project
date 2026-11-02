import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'

export async function GET() {
  const user = await getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const supabase = await createSupabaseServer()
  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  if (error) return new Response(error.message, { status: 500 })
  return Response.json({ projects })
}

export async function POST(request: Request) {
  const user = await getUser()
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { name, description } = await request.json()
  if (!name?.trim()) {
    return new Response('name is required', { status: 400 })
  }

  try {
    const supabase = await createSupabaseServer()

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name: name.trim(),
        description: description?.trim() || null,
      })
      .select()
      .single()

    if (projectError || !project) {
      throw projectError ?? new Error('Failed to create project')
    }

    return Response.json({ projectId: project.id })
  } catch (error: any) {
    return new Response(error.message || 'Failed to create project', { status: 500 })
  }
}
