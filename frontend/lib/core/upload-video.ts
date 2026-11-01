import type { CoreUpload } from './types'

export interface UploadedVideo {
  /** `upload:<id>` — what `POST /api/videos` hands the backend to ingest. */
  source: string
  title: string
}

/**
 * Send a video file to the backend's storage and return the source to ingest.
 *
 * Two steps: `/api/uploads` asks the backend for a one-time URL, then the file
 * goes straight there with a PUT — Azure Blob Storage in production, the
 * backend itself in development. The video is stored once, by the backend.
 */
export async function uploadProjectVideo(projectId: string, file: File): Promise<UploadedVideo> {
  const contentType = file.type || 'video/mp4'
  const ticket = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, filename: file.name, contentType }),
  })
  if (!ticket.ok) {
    throw new Error(`Upload failed for "${file.name}": ${(await ticket.text()) || ticket.statusText}`)
  }
  const upload = (await ticket.json()) as CoreUpload

  const sent = await fetch(upload.upload_url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
  })
  if (!sent.ok) {
    throw new Error(`Upload failed for "${file.name}": the storage server answered ${sent.status}`)
  }

  return { source: upload.source, title: file.name.replace(/\.[^.]+$/, '') }
}
