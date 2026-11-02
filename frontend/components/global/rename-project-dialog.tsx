'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useRenameProject } from '@/hooks/use-projects'

interface RenameProjectDialogProps {
  projectId: string
  currentName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameProjectDialog({
  projectId,
  currentName,
  open,
  onOpenChange,
}: RenameProjectDialogProps) {
  const [name, setName] = useState(currentName)
  const rename = useRenameProject()

  useEffect(() => {
    if (open) setName(currentName)
  }, [open, currentName])

  const trimmed = name.replace(/\s+/g, ' ').trim()

  const submit = () => {
    if (!trimmed || trimmed === currentName) {
      onOpenChange(false)
      return
    }
    rename.mutate(
      { projectId, name: trimmed },
      {
        onSuccess: () => onOpenChange(false),
        onError: (error) => toast.error('Could not rename project', { description: error.message }),
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
        </DialogHeader>
        <form
          id="rename-project"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <Input
            value={name}
            maxLength={100}
            autoFocus
            aria-label="Project name"
            onChange={(event) => setName(event.target.value)}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="rename-project" disabled={!trimmed || rename.isPending}>
            {rename.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
