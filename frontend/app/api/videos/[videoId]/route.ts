import { createSupabaseServer } from '@/lib/supabase/server'
import { getUser } from '@/app/agent/hooks/get-user'
import { core } from '@/lib/core/client'
import { reconcileVideo } from '@/lib/core/reconcile'
import type { ProjectVideo } from '@/lib/core/types'

type Params = Promise<{ videoId: string }>

async function loadOwnedVideo(videoId: string) {
  const user = await getUser()
  if (!user) return { error: new Response('Unauthorized', { status: 401 }) }

  const supabase = await createSupabaseServer()
  const { data: video } = await supabase
    .from('video_core')
    .select('*')
    .eq('id', videoId)
    .eq('user_id', user.id)
    .single()

  if (!video) return { error: new Response('Video not found', { status: 404 }) }

  return { video: video as ProjectVideo, supabase }
}

/** Refresh one video's ingest progress from core and persist what changed. */
export async function GET(_request: Request, { params }: { params: Params }) {
  const { videoId } = await params
  const { video, supabase, error } = await loadOwnedVideo(videoId)
  if (error) return error

  try {
    return Response.json({ video: await reconcileVideo(supabase!, video!) })
  } catch {
    // Backend down — the stored row is still the best answer we have.
    return Response.json({ video })
  }
}

const MAX_TITLE = 200

/**
 * Rename a video or move it to another project. Both live only on this row:
 * core keys videos by content hash and the agent reads titles and project
 * membership from here, so nothing else needs telling.
 */
export async function PATCH(request: Request, { params }: { params: Params }) {
  const { videoId } = await params
  const { video, supabase, error } = await loadOwnedVideo(videoId)
  if (error) return error

  let body: { title?: unknown; projectId?: unknown } = {}
  try {
    body = await request.json()
  } catch {
    return new Response('Expected a JSON body', { status: 400 })
  }

  const update: { title?: string; project_id?: string } = {}

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : ''
    if (!title) return new Response('Title cannot be empty', { status: 400 })
    if (title.length > MAX_TITLE) {
      return new Response(`Title must be ${MAX_TITLE} characters or fewer`, { status: 400 })
    }
    update.title = title
  }

  if (body.projectId !== undefined) {
    if (typeof body.projectId !== 'string') {
      return new Response('projectId must be a string', { status: 400 })
    }
    const { data: project } = await supabase!
      .from('projects')
      .select('id')
      .eq('id', body.projectId)
      .eq('user_id', video!.user_id)
      .maybeSingle()
    if (!project) return new Response('Project not found', { status: 404 })
    update.project_id = project.id
  }

  if (Object.keys(update).length === 0) {
    return new Response('Nothing to update', { status: 400 })
  }

  const { data, error: updateError } = await supabase!
    .from('video_core')
    .update(update)
    .eq('id', videoId)
    .select('*')
    .single()

  if (updateError) return new Response(updateError.message, { status: 500 })
  return Response.json({ video: data })
}

export async function DELETE(_request: Request, { params }: { params: Params }) {
  const { videoId } = await params
  const { video, supabase, error } = await loadOwnedVideo(videoId)
  if (error) return error

  // Core identifies a video by the hash of its bytes, so the same file uploaded
  // to two projects is one video in core. Deleting it because *this* row went
  // away would silently destroy the other project's analysis, so core is only
  // told once nothing else points at it.
  if (video!.core_video_id) {
    const { count } = await supabase!
      .from('video_core')
      .select('id', { count: 'exact', head: true })
      .eq('core_video_id', video!.core_video_id)
      .neq('id', videoId)

    if (!count) {
      try {
        await core.remove(video!.core_video_id)
      } catch {
        // Already gone from core, or core is down — still drop our row.
      }
    }
  }

  // Only videos uploaded before the backend stored them have a copy in Supabase.
  // A newer upload's source is `upload:<id>`, and the backend just deleted its file.
  if (
    video!.source_type === 'upload' &&
    video!.storage_path &&
    !video!.source_url?.startsWith('upload:')
  ) {
    await supabase!.storage.from('project-assets').remove([video!.storage_path])
  }

  const { error: deleteError } = await supabase!.from('video_core').delete().eq('id', videoId)
  if (deleteError) return new Response(deleteError.message, { status: 500 })

  return Response.json({ deleted: true })
}
