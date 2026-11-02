'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatDistanceToNowStrict } from 'date-fns'
import { Film, FolderOpen, MessageSquare, MoreHorizontal, Pencil, PlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { RenameProjectDialog } from '@/components/global/rename-project-dialog'
import { cn } from '@/lib/utils'

interface ProjectRow {
  id: string
  name: string
  description: string | null
  updated_at: string
}

interface ConversationRow {
  id: string
  title: string
  project_id: string
  updated_at: string
}

interface VideoRow {
  id: string
  project_id: string
  poster_url: string | null
  duration: number | null
  status: string
}

interface ProjectsPageClientProps {
  userName: string | null
  projects: ProjectRow[]
  conversations: ConversationRow[]
  videos: VideoRow[]
}

interface ProjectSummary {
  project: ProjectRow
  posters: string[]
  videoCount: number
  conversationCount: number
  lastActive: string
}

const RECENT_LIMIT = 6

function timeAgo(iso: string) {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true })
}

function formatFootage(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

function plural(count: number, word: string) {
  return count === 1 ? word : `${word}s`
}

function Poster({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) {
    return (
      <div className={cn('flex items-center justify-center bg-muted', className)}>
        <Film className="size-1/3 max-h-5 max-w-5 text-muted-foreground/40" />
      </div>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- posters live in core's bucket
    <img src={src} alt="" onError={() => setFailed(true)} className={cn('object-cover', className)} />
  )
}

function PosterMosaic({ posters }: { posters: string[] }) {
  if (posters.length === 0) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-2 bg-muted/40 text-xs text-muted-foreground">
        <Film className="size-5 text-muted-foreground/50" />
        No videos yet
      </div>
    )
  }
  if (posters.length === 1) return <Poster src={posters[0]} className="size-full" />

  const tiles = posters.slice(0, 3)
  return (
    <div className="grid size-full grid-cols-3 grid-rows-2 gap-0.5">
      {tiles.map((src, index) => (
        <Poster
          key={index}
          src={src}
          className={cn(
            'size-full',
            index === 0 && 'col-span-2 row-span-2',
            tiles.length === 2 && index === 1 && 'row-span-2'
          )}
        />
      ))}
    </div>
  )
}

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 text-sm font-semibold">{children}</h2>
}

function RecentConversation({
  conversation,
  project,
}: {
  conversation: ConversationRow
  project?: ProjectSummary
}) {
  return (
    <Link
      href={`/projects/${conversation.project_id}/conversations/${conversation.id}`}
      className="flex flex-col justify-between gap-4 rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm"
    >
      <div className="flex gap-2.5">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="line-clamp-2 text-sm font-medium leading-snug">{conversation.title}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Poster src={project?.posters[0]} className="size-5 shrink-0 rounded" />
        <span className="truncate">{project?.project.name}</span>
        <span className="ml-auto shrink-0">{timeAgo(conversation.updated_at)}</span>
      </div>
    </Link>
  )
}

function ProjectCard({ summary, onRename }: { summary: ProjectSummary; onRename: () => void }) {
  const { project, posters, videoCount, conversationCount, lastActive } = summary

  return (
    <div className="group relative">
      <Link
        href={`/projects/${project.id}`}
        className="flex h-full flex-col overflow-hidden rounded-2xl border bg-card transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
      >
        <div className="aspect-2/1 overflow-hidden border-b">
          <PosterMosaic posters={posters} />
        </div>
        <div className="flex flex-1 flex-col p-4">
          <h3 className="truncate font-semibold">{project.name}</h3>
          {project.description && (
            <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{project.description}</p>
          )}
          <div className="mt-auto flex items-center gap-4 pt-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Film className="size-3.5" />
              {videoCount} {plural(videoCount, 'video')}
            </span>
            <span className="flex items-center gap-1.5">
              <MessageSquare className="size-3.5" />
              {conversationCount} {plural(conversationCount, 'chat')}
            </span>
            <span className="ml-auto">{timeAgo(lastActive)}</span>
          </div>
        </div>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Project options"
          className="absolute right-2.5 top-2.5 rounded-md bg-background/85 p-1 opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onRename}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ProjectsPageClient({
  userName,
  projects,
  conversations,
  videos,
}: ProjectsPageClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(searchParams.get('create') === '1')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [renaming, setRenaming] = useState<ProjectRow | null>(null)

  const summaries = useMemo(() => {
    const byId = new Map<string, ProjectSummary>(
      projects.map((project) => [
        project.id,
        { project, posters: [], videoCount: 0, conversationCount: 0, lastActive: project.updated_at },
      ])
    )
    for (const video of videos) {
      const summary = byId.get(video.project_id)
      if (!summary) continue
      summary.videoCount += 1
      if (video.poster_url) summary.posters.push(video.poster_url)
    }
    for (const conversation of conversations) {
      const summary = byId.get(conversation.project_id)
      if (!summary) continue
      summary.conversationCount += 1
      if (conversation.updated_at > summary.lastActive) summary.lastActive = conversation.updated_at
    }
    return byId
  }, [projects, conversations, videos])

  const sortedProjects = useMemo(
    () => [...summaries.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive)),
    [summaries]
  )

  const indexedSeconds = useMemo(
    () =>
      videos
        .filter((video) => video.status === 'ready')
        .reduce((total, video) => total + (video.duration ?? 0), 0),
    [videos]
  )

  const recent = conversations.slice(0, RECENT_LIMIT)
  const firstName = userName?.split(' ')[0]

  const handleCreateProject = async () => {
    if (!name.trim()) {
      toast.error('Project name is required')
      return
    }

    setIsCreating(true)
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
        }),
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      const { projectId } = await response.json()
      setOpen(false)
      router.push(`/projects/${projectId}`)
      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to create project')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick up a conversation, or open a project to search its footage.
          </p>
        </div>
        <Button className="rounded-full" onClick={() => setOpen(true)}>
          <PlusIcon className="size-4" />
          New project
        </Button>
      </header>

      {projects.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed px-6 py-16 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted">
            <FolderOpen className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-4 font-semibold">No projects yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            A project holds a set of videos and the conversations about them. Create one, add a
            video, and start asking questions.
          </p>
          <Button className="mt-5 rounded-full" onClick={() => setOpen(true)}>
            <PlusIcon className="size-4" />
            Create project
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-4">
            <Stat value={projects.length} label={plural(projects.length, 'Project')} />
            <Stat value={videos.length} label={plural(videos.length, 'Video')} />
            <Stat value={formatFootage(indexedSeconds)} label="Footage indexed" />
            <Stat value={conversations.length} label={plural(conversations.length, 'Conversation')} />
          </div>

          {recent.length > 0 && (
            <section className="mt-12">
              <SectionTitle>Continue where you left off</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {recent.map((conversation) => (
                  <RecentConversation
                    key={conversation.id}
                    conversation={conversation}
                    project={summaries.get(conversation.project_id)}
                  />
                ))}
              </div>
            </section>
          )}

          <section className="mt-12">
            <SectionTitle>Projects</SectionTitle>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {sortedProjects.map((summary) => (
                <ProjectCard
                  key={summary.project.id}
                  summary={summary}
                  onRename={() => setRenaming(summary.project)}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project name</label>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="My project" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description (optional)</label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this project is about"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateProject} disabled={isCreating}>
              {isCreating ? 'Creating...' : 'Create project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RenameProjectDialog
        projectId={renaming?.id ?? ''}
        currentName={renaming?.name ?? ''}
        open={Boolean(renaming)}
        onOpenChange={(next) => !next && setRenaming(null)}
      />
    </div>
  )
}
