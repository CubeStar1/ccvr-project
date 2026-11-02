'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowUp, Clock, Film, Loader2, PanelLeft, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useSidebar } from '@/components/ui/sidebar'
import { ModeToggle } from '@/components/global/theme-switcher'
import { VideoPlayer } from '@/app/agent/components/video-player'
import { VideoPicker, VideoChips } from '@/app/agent/components/video-picker'
import { VoiceInputButton } from '@/app/agent/components/voice-input-button'
import { useProjectVideos, useVideoMutations } from '@/hooks/use-project-videos'
import { useConversationHistory } from '@/app/agent/hooks/use-conversation-history'
import { useProjects } from '@/hooks/use-projects'
import { RenameProjectDialog } from '@/components/global/rename-project-dialog'
import { formatDuration, formatTimestamp } from '@/lib/core/format'
import type { Project } from '@/app/agent/types'
import type { ProjectVideo } from '@/lib/core/types'
import { MediaGrid } from './media-grid'
import { PromptSuggestions, type Suggestion } from './prompt-suggestions'
import { UploadDialog } from './upload-dialog'

interface WorkspaceClientProps {
  project: Project
  initialVideos: ProjectVideo[]
}

export function WorkspaceClient({ project, initialVideos }: WorkspaceClientProps) {
  const router = useRouter()
  const { toggleSidebar } = useSidebar()
  const [prompt, setPrompt] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [preview, setPreview] = useState<ProjectVideo | null>(null)
  const [isStarting, setIsStarting] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([])
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const { videos, readyVideos, isLoading } = useProjectVideos(project.id, initialVideos)
  const { remove, reindex, rename, move, invalidate } = useVideoMutations(project.id)
  const history = useConversationHistory()
  const { data: projects } = useProjects()
  const moveTargets = useMemo(
    () => (projects ?? []).filter((item) => item.id !== project.id),
    [projects, project.id]
  )

  /** How much footage is actually searchable — the only number worth surfacing up top. */
  const indexedSeconds = useMemo(
    () => readyVideos.reduce((total, video) => total + (video.duration ?? 0), 0),
    [readyVideos]
  )

  const indexingCount =
    videos.length - readyVideos.length - videos.filter((v) => v.status === 'failed').length

  /** Suggestions follow the scope: the tagged videos, or the whole library when none are. */
  const suggestionScope = useMemo(() => {
    const tagged = readyVideos.filter((video) =>
      selectedVideoIds.includes(video.core_video_id as string)
    )
    return tagged.length > 0 ? tagged : readyVideos
  }, [readyVideos, selectedVideoIds])

  /**
   * Suggestions seed the box and hand the caret over — the user still hits send.
   * One that names a video also scopes the chat to it, so the agent searches the
   * right footage; the chip it adds can be removed like any other.
   */
  const pickSuggestion = useCallback(
    (suggestion: Suggestion) => {
      setPrompt(suggestion.text)
      // Prompts say "the video", so the chat must be scoped to exactly the
      // videos the suggestion is about. Covering the whole library needs no tag.
      const scope = readyVideos
        .filter((item) => suggestion.videoIds.includes(item.id) && item.core_video_id)
        .map((item) => item.core_video_id as string)
      if (scope.length > 0 && scope.length < readyVideos.length) {
        setSelectedVideoIds(scope)
      }
      const input = promptRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(suggestion.text.length, suggestion.text.length)
    },
    [readyVideos]
  )

  /** Dictation adds to whatever is already typed, then hands the caret back. */
  const appendTranscript = useCallback(
    (text: string) => {
      const next = prompt.trim() ? `${prompt.trim()} ${text}` : text
      setPrompt(next)

      const input = promptRef.current
      if (!input) return
      input.focus()
      // The caret belongs after the dictated text, once React has written it.
      requestAnimationFrame(() => input.setSelectionRange(next.length, next.length))
    },
    [prompt]
  )

  const toggleVideo = useCallback((videoId: string) => {
    setSelectedVideoIds((current) =>
      current.includes(videoId) ? current.filter((item) => item !== videoId) : [...current, videoId]
    )
  }, [])

  /**
   * Start a chat: create the conversation up front so the workspace and the chat
   * page agree on the id, then hand the prompt over through the URL.
   */
  const startChat = async (text: string) => {
    const message = text.trim()
    if (!message) return

    if (videos.length === 0) {
      toast.error('Upload a video first', {
        description: 'The agent answers from videos indexed in this project.',
      })
      return
    }

    setIsStarting(true)
    try {
      const response = await fetch(`/api/projects/${project.id}/conversations`, {
        method: 'POST',
      })

      if (!response.ok) throw new Error(await response.text())

      const { conversationId } = await response.json()
      void history.refresh()
      const params = new URLSearchParams({ q: message })
      // Whatever the user tagged, or every ready video if they tagged nothing.
      const scope =
        selectedVideoIds.length > 0
          ? selectedVideoIds
          : readyVideos.map((video) => video.core_video_id as string)
      if (scope.length > 0) {
        params.set('videos', scope.join(','))
      }
      router.push(`/projects/${project.id}/conversations/${conversationId}?${params}`)
    } catch (error: any) {
      toast.error('Could not start the chat', { description: error.message })
      setIsStarting(false)
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-background/80 px-4 py-2 backdrop-blur">
        <button
          onClick={() => toggleSidebar()}
          className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Toggle sidebar"
        >
          <PanelLeft className="size-4" />
        </button>
        <div className="ml-auto">
          <ModeToggle />
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 pb-20 pt-14 sm:px-6 sm:pt-20">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            <span className="group/title relative">
              {project.name}
              <button
                onClick={() => setRenameOpen(true)}
                title="Rename project"
                className="absolute -right-9 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/title:opacity-100"
              >
                <Pencil className="size-4" />
              </button>
            </span>
          </h1>
          {project.description && (
            <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
          )}
          <LibraryStats
            videos={readyVideos}
            seconds={indexedSeconds}
            processing={indexingCount}
            onUpload={() => setUploadOpen(true)}
          />
        </div>

        {/* Prompt launcher */}
        <div className="mx-auto mt-8 max-w-2xl rounded-2xl border bg-card p-2.5 shadow-sm transition-[border-color,box-shadow] focus-within:border-foreground/20 focus-within:shadow-md">
          <div className="-mx-2.5 -mt-2.5 mb-1">
            <VideoChips videos={videos} selectedIds={selectedVideoIds} onRemove={toggleVideo} />
          </div>
          <Textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void startChat(prompt)
              }
            }}
            placeholder={
              readyVideos.length > 0
                ? 'Describe a moment, ask a question, or request a clip'
                : 'Add a video to start asking questions'
            }
            className="min-h-16 resize-none border-0 bg-transparent p-2 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => setUploadOpen(true)}
              >
                <Plus className="size-3.5" />
                Add video
              </Button>
              <VideoPicker
                videos={videos}
                selectedIds={selectedVideoIds}
                onToggle={toggleVideo}
                onClear={() => setSelectedVideoIds([])}
              />
              <VoiceInputButton onTranscript={appendTranscript} disabled={isStarting} />
            </div>
            <div className="flex items-center gap-2.5">
              {readyVideos.length > 0 && (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {selectedVideoIds.length > 0
                    ? `${selectedVideoIds.length} of ${readyVideos.length} tagged`
                    : readyVideos.length === 1
                      ? '1 video'
                      : `All ${readyVideos.length} videos`}
                </span>
              )}
              <Button
                size="icon"
                className="size-8 rounded-full"
                disabled={!prompt.trim() || isStarting}
                onClick={() => void startChat(prompt)}
                title="Start chat"
              >
                {isStarting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className="mx-auto mt-6 max-w-2xl">
          <PromptSuggestions
            videos={suggestionScope}
            libraryCount={readyVideos.length}
            onSelect={pickSuggestion}
          />
        </div>

        <MediaGrid
          videos={videos}
          projectId={project.id}
          isLoading={isLoading}
          onPreview={setPreview}
          onRename={(videoId, title) =>
            rename.mutate(
              { videoId, title },
              {
                onError: (error: any) =>
                  toast.error('Could not rename video', { description: error.message }),
              }
            )
          }
          moveTargets={moveTargets}
          onMove={(videoId, target) =>
            move.mutate(
              { videoId, targetProjectId: target.id },
              {
                onSuccess: () =>
                  toast.success(`Moved to ${target.name}`, {
                    action: {
                      label: 'Open',
                      onClick: () => router.push(`/projects/${target.id}`),
                    },
                  }),
                onError: (error: any) =>
                  toast.error('Could not move video', { description: error.message }),
              }
            )
          }
          onUpload={() => setUploadOpen(true)}
          onDelete={(videoId) =>
            remove.mutate(videoId, {
              onSuccess: () => toast.success('Video deleted'),
              onError: (error: any) => toast.error(error.message),
            })
          }
          onReindex={(videoId) =>
            reindex.mutate(videoId, {
              onSuccess: () => toast.success('Re-indexing started'),
              onError: (error: any) => toast.error(error.message),
            })
          }
        />
      </div>

      <RenameProjectDialog
        projectId={project.id}
        currentName={project.name}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <UploadDialog
        projectId={project.id}
        projectName={project.name}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onComplete={invalidate}
      />

      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-6">{preview?.title}</DialogTitle>
          </DialogHeader>
          <VideoPlayer src={preview?.playback_url} poster={preview?.poster_url} autoPlay />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{formatDuration(preview?.duration)}</span>
            <span>·</span>
            <span className="capitalize">{preview?.status}</span>
            {preview?.error && <span className="truncate text-red-500">{preview.error}</span>}
            {preview && (
              <Link
                href={`/projects/${project.id}/videos/${preview.id}`}
                className="ml-auto font-medium text-foreground hover:underline"
              >
                View full analysis →
              </Link>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * What the project holds, as one segmented pill: a peek at the footage, how
 * much of it there is, and anything still being processed.
 */
function LibraryStats({
  videos,
  seconds,
  processing,
  onUpload,
}: {
  videos: ProjectVideo[]
  seconds: number
  processing: number
  onUpload: () => void
}) {
  if (videos.length === 0 && processing === 0) {
    return (
      <button
        type="button"
        onClick={onUpload}
        className="mt-4 inline-flex items-center gap-2 rounded-full border border-dashed px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Film className="size-3.5" />
        No videos yet — add one to start
      </button>
    )
  }

  const posters = videos.filter((video) => video.poster_url).slice(0, 3)

  return (
    <div className="mt-4 inline-flex items-stretch divide-x overflow-hidden rounded-full border bg-card/60 text-xs shadow-xs">
      {videos.length > 0 && (
        <div className="flex items-center gap-2.5 py-1 pl-1.5 pr-3.5">
          {posters.length > 0 ? (
            <span className="flex -space-x-2.5">
              {posters.map((video, index) => (
                // eslint-disable-next-line @next/next/no-img-element -- posters live in core's bucket
                <img
                  key={video.id}
                  src={video.poster_url as string}
                  alt=""
                  style={{ zIndex: posters.length - index }}
                  className="relative h-6 w-10 rounded-full border-2 border-card object-cover"
                />
              ))}
            </span>
          ) : (
            <span className="flex size-6 items-center justify-center rounded-full bg-muted">
              <Film className="size-3 text-muted-foreground" />
            </span>
          )}
          <span className="text-muted-foreground">
            <span className="font-medium tabular-nums text-foreground">{videos.length}</span>{' '}
            {videos.length === 1 ? 'video' : 'videos'}
          </span>
        </div>
      )}

      {seconds >= 1 && (
        <div className="flex items-center gap-1.5 px-3.5 text-muted-foreground">
          <Clock className="size-3.5" />
          <span className="font-medium tabular-nums text-foreground">
            {formatTimestamp(seconds)}
          </span>
          <span className="hidden sm:inline">of footage</span>
        </div>
      )}

      {processing > 0 && (
        <div className="flex items-center gap-1.5 px-3.5 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="font-medium tabular-nums text-foreground">{processing}</span>
          processing
        </div>
      )}
    </div>
  )
}
