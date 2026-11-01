'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  Braces,
  CheckCircle2,
  ExternalLink,
  Layers,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { formatBytes, formatDuration } from '@/lib/core/format'
import { describeChunking } from '@/lib/core/chunking'
import { useVideoDetails } from '@/hooks/use-video-details'
import { useVideoMutations } from '@/hooks/use-project-videos'
import { VideoPlayer, type VideoPlayerHandle } from '@/app/agent/components/video-player'
import type { AnalyzerId, ChunkOut, ProjectVideo } from '@/lib/core/types'
import { ChunkPanel } from './chunk-panel'
import { OverviewPanel } from './overview-panel'
import { EntitiesPanel } from './entities-panel'
import { SpeechPanel } from './speech-panel'
import { RawPanel } from './raw-panel'
import { Chips } from './detail-primitives'

/** Underline tabs: quieter than a pill tray, and the active one is unmistakable. */
const TAB_TRIGGER = cn(
  'relative h-full flex-none gap-1.5 rounded-none border-0 bg-transparent px-3 text-[13px] font-medium text-muted-foreground shadow-none',
  'hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none',
  'dark:text-muted-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-foreground',
  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity data-[state=active]:after:opacity-100'
)

interface VideoDetailClientProps {
  projectId: string
  projectName: string
  initialVideo: ProjectVideo
}

/**
 * Everything stored for one video, on one page.
 *
 * The player stays pinned beside the analysis rather than above it, because
 * every timestamp here is a seek — a chunk, a turn, a sighting and an event are
 * all "this moment in the file", and reading them next to the frame they
 * describe is the whole point of the page.
 */
export function VideoDetailClient({
  projectId,
  projectName,
  initialVideo,
}: VideoDetailClientProps) {
  const router = useRouter()
  const playerRef = useRef<VideoPlayerHandle>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [tab, setTab] = useState('overview')
  const [focusChunkId, setFocusChunkId] = useState<number | null>(null)

  const { details, isLoading, isFetching, error, refetch } = useVideoDetails(initialVideo.id)
  const { remove, reindex, reaggregate } = useVideoMutations(projectId)

  const video = details?.video ?? initialVideo
  const chunks = details?.chunks ?? []
  const aggregates = details?.aggregates ?? {}

  const analyzers = useMemo<AnalyzerId[]>(
    () => (details?.core?.analyzers ?? video.analyzers ?? []) as AnalyzerId[],
    [details?.core?.analyzers, video.analyzers]
  )

  // The row's duration can be null for a video whose ingest never reported one;
  // the last chunk's end is the next best thing every panel can share.
  const duration = video.duration || details?.core?.duration || chunks.at(-1)?.end || 0

  const seek = useCallback((seconds: number) => {
    playerRef.current?.seekTo(seconds)
    setCurrentTime(seconds)
  }, [])

  const openChunk = useCallback((chunkId: number) => {
    setTab('chunks')
    // A new object each time, so re-clicking the same chunk scrolls again.
    setFocusChunkId(chunkId)
  }, [])

  const handleTimeUpdate = useCallback((seconds: number) => {
    setCurrentTime(Math.round(seconds * 10) / 10)
  }, [])

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <header className="z-30 shrink-0 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-400 flex-wrap items-center gap-3 px-4 py-3 lg:px-8">
          <Link
            href={`/projects/${projectId}`}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {projectName}
          </Link>

          <span className="text-muted-foreground/30">/</span>

          <h1
            className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight"
            title={video.title}
          >
            {video.title}
          </h1>

          <StatusPill video={video} />

          {isFetching && !isLoading && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          )}

          <div className="flex items-center gap-1.5">
            <Button asChild variant="outline" size="sm" className="h-8">
              <Link href={`/projects/${projectId}`}>
                <MessageSquare className="size-3.5" />
                Ask about it
              </Link>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void refetch()}>
                  <RefreshCw className="size-4" />
                  Reload analysis
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    reaggregate.mutate(
                      { videoId: video.id },
                      {
                        onSuccess: () =>
                          toast.success('Re-running video-level passes', {
                            description: 'Summary, chapters, events and entities bill LLM calls.',
                          }),
                        onError: (mutationError: any) => toast.error(mutationError.message),
                      }
                    )
                  }
                >
                  <Sparkles className="size-4" />
                  Re-run aggregates
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    reindex.mutate(video.id, {
                      onSuccess: () => toast.success('Re-indexing started'),
                      onError: (mutationError: any) => toast.error(mutationError.message),
                    })
                  }
                >
                  <RefreshCw className="size-4" />
                  Re-index from scratch
                </DropdownMenuItem>
                {video.playback_url && (
                  <DropdownMenuItem asChild>
                    <a href={video.playback_url} target="_blank" rel="noreferrer">
                      <ExternalLink className="size-4" />
                      Open the mp4
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600"
                  onClick={() =>
                    remove.mutate(video.id, {
                      onSuccess: () => {
                        toast.success('Video deleted')
                        router.push(`/projects/${projectId}`)
                      },
                      onError: (mutationError: any) => toast.error(mutationError.message),
                    })
                  }
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/*
        Two independent scroll regions on a wide screen: the player and summary
        stay put while the analysis scrolls past them, because every timestamp
        in the right-hand column is a seek and losing sight of the frame it
        refers to defeats the point. Below `lg` they stack and the page scrolls
        as one.
      */}
      <div className="mx-auto flex w-full min-h-0 max-w-400 flex-1 flex-col overflow-y-auto lg:flex-row lg:gap-8 lg:overflow-hidden lg:px-8">
        {/* Player and the facts about the file */}
        <aside className="shrink-0 space-y-4 px-4 pb-2 pt-5 lg:w-100 lg:overflow-y-auto lg:px-0 lg:pb-8">
          <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-sm">
            <VideoPlayer
              ref={playerRef}
              src={video.playback_url}
              poster={video.poster_url}
              className="w-full rounded-none"
              onTimeUpdate={handleTimeUpdate}
            />
            <div className="flex items-center justify-between px-4 py-2.5 text-[12px] tabular-nums text-muted-foreground">
              <span>
                <span className="text-foreground/90">{formatDuration(currentTime)}</span>
                <span className="text-muted-foreground/60"> / {formatDuration(duration)}</span>
              </span>
              <span className="truncate pl-2">{activeChunkLabel(chunks, currentTime)}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-card/50 p-4">
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/50">
              <Meta label="Duration">{formatDuration(duration)}</Meta>
              <Meta label="Chunks">
                {details?.chunk_total || video.chunk_count || 0}
                {details && details.chunk_total > chunks.length && (
                  <span className="text-[12px] font-normal text-muted-foreground">
                    {' '}
                    ({chunks.length} loaded)
                  </span>
                )}
              </Meta>
              <Meta label="Size">{formatBytes(video.size_bytes ?? details?.core?.size_bytes)}</Meta>
              <Meta label="Chunking">
                <span className="capitalize">
                  {video.chunk_config ?? details?.core?.chunk_config ?? '—'}
                </span>
              </Meta>
            </dl>

            <div className="mt-4 space-y-3.5">
              <div>
                <div className="mb-1.5 text-[11px] text-muted-foreground">Analyzers</div>
                {analyzers.length > 0 ? (
                  <Chips items={analyzers.map(prettyId)} tone="outline" />
                ) : (
                  <span className="text-[12px] text-muted-foreground">None recorded</span>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-[11px] text-muted-foreground">Aggregates</div>
                {Object.keys(aggregates).length > 0 ? (
                  <Chips items={Object.keys(aggregates).sort().map(prettyId)} tone="muted" />
                ) : (
                  <span className="text-[12px] text-muted-foreground">None stored</span>
                )}
              </div>
            </div>

            {video.ingest_config && (
              <p className="mt-4 border-t border-border/50 pt-3 text-[12px] leading-relaxed text-muted-foreground">
                {describeChunking(video.ingest_config)}
              </p>
            )}
          </div>
        </aside>

        {/* The analysis */}
        <main className="flex min-w-0 flex-1 flex-col px-4 lg:min-h-0 lg:px-0">
          {isLoading ? (
            <div className="pt-2">
              <LoadingSkeleton />
            </div>
          ) : (
            <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
              <TabsList className="sticky top-0 z-20 h-12 w-full shrink-0 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none border-b border-border/60 bg-background p-0 [scrollbar-width:none] lg:static [&::-webkit-scrollbar]:hidden">
                <TabsTrigger value="overview" className={TAB_TRIGGER}>
                  <Sparkles className="size-3.5" />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="chunks" className={TAB_TRIGGER}>
                  <Layers className="size-3.5" />
                  Chunks
                  <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                    {chunks.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="speech" className={TAB_TRIGGER}>
                  <MessageSquare className="size-3.5" />
                  Speech
                </TabsTrigger>
                <TabsTrigger value="entities" className={TAB_TRIGGER}>
                  <Users className="size-3.5" />
                  People &amp; objects
                </TabsTrigger>
                <TabsTrigger value="raw" className={TAB_TRIGGER}>
                  <Braces className="size-3.5" />
                  Record
                </TabsTrigger>
              </TabsList>

              {/* Only the panels scroll; the tab bar above stays put on a solid background. */}
              <div className="min-h-0 flex-1 pb-10 pt-5 lg:overflow-y-auto">
                {error && (
                  <Banner tone="error">
                    {(error as Error).message || 'Could not load this video’s analysis.'}
                  </Banner>
                )}

                {details?.errors.map((message) => (
                  <Banner key={message} tone="warning">
                    {message}
                  </Banner>
                ))}

                <TabsContent value="overview">
                  <OverviewPanel
                    aggregates={aggregates}
                    duration={duration}
                    onSeek={seek}
                    onOpenChunk={openChunk}
                  />
                </TabsContent>

                <TabsContent value="chunks">
                  <ChunkPanel
                    chunks={chunks}
                    chunkTotal={details?.chunk_total ?? chunks.length}
                    analyzers={analyzers}
                    duration={duration}
                    currentTime={currentTime}
                    focusChunkId={focusChunkId}
                    onSeek={seek}
                  />
                </TabsContent>

                <TabsContent value="speech">
                  <SpeechPanel
                    chunks={chunks}
                    aggregates={aggregates}
                    currentTime={currentTime}
                    onSeek={seek}
                    onOpenChunk={openChunk}
                  />
                </TabsContent>

                <TabsContent value="entities">
                  <EntitiesPanel
                    aggregates={aggregates}
                    chunks={chunks}
                    duration={duration}
                    onSeek={seek}
                    onOpenChunk={openChunk}
                  />
                </TabsContent>

                <TabsContent value="raw">{details && <RawPanel details={details} />}</TabsContent>
              </div>
            </Tabs>
          )}
        </main>
      </div>
    </div>
  )
}

/** Which chunk the playhead is inside, shown under the player as a bearing. */
function activeChunkLabel(chunks: ChunkOut[], currentTime: number): string {
  const index = chunks.findIndex((chunk) => currentTime >= chunk.start && currentTime < chunk.end)
  return index >= 0 ? `Chunk ${index + 1} of ${chunks.length}` : ''
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-card px-3.5 py-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-[15px] font-semibold tabular-nums tracking-tight">
        {children}
      </dd>
    </div>
  )
}

/** `object_detection` -> `object detection`, for chips a person reads. */
function prettyId(id: string) {
  return id.replace(/_/g, ' ')
}

function StatusPill({ video }: { video: ProjectVideo }) {
  if (video.status === 'ready') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-3" />
        Ready
      </span>
    )
  }

  if (video.status === 'failed') {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-600 dark:text-red-400"
        title={video.error ?? undefined}
      >
        <AlertTriangle className="size-3" />
        Failed
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
      <Loader2 className="size-3 animate-spin" />
      {video.stage ?? video.status}
    </span>
  )
}

function Banner({ tone, children }: { tone: 'error' | 'warning'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'mb-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px]',
        tone === 'error'
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <div className="h-11 w-full animate-pulse border-b border-border/60" />
      {[280, 180, 220].map((height, index) => (
        <div key={index} className="animate-pulse rounded-2xl bg-muted/50" style={{ height }} />
      ))}
    </div>
  )
}
