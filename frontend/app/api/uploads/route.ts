import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'
import { core, CoreApiError } from '@/lib/core/client'

/**
 * Hand the browser a one-time URL to upload a video file to.
 *
 * The bytes never pass through here — Vercel caps request bodies far below a
 * video's size, and the backend token must not reach the browser. Instead the
 * backend issues a short-lived, single-file URL (an Azure SAS in production)
 * and the browser PUTs the file straight to it. Registering the video
 * afterwards goes through `POST /api/videos` with the returned `source`.
 */
export async function POST(request: Request) {
  const user = await getUser()
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { projectId, filename, contentType } = await request.json()
  if (!projectId) return new Response('projectId is required', { status: 400 })
  if (!filename) return new Response('filename is required', { status: 400 })

  const supabase = await createSupabaseServer()
  const { data: project } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single()
  if (!project) return new Response('Project not found', { status: 404 })

  try {
    return Response.json(await core.createUpload(filename, contentType))
  } catch (error: any) {
    const status = error instanceof CoreApiError ? error.status : 502
    return new Response(error?.message || 'Could not start the upload', { status })
  }
}
