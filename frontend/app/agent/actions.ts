'use server'

import { createSupabaseServer } from '@/lib/supabase/server'
import { type UIMessage } from 'ai'
import { generateText } from 'ai'
import { myProvider } from '@/app/agent/lib/ai/providers/providers'

import { AppUsage } from './types'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string | undefined): value is string {
  return Boolean(value && UUID_PATTERN.test(value))
}

export async function getChatById(id: string) {
  const supabase = await createSupabaseServer()
  const { data } = await supabase.from('conversations').select('*').eq('id', id).single()
  return data
}

export async function saveChat(chat: { id: string, userId: string, title: string, projectId?: string }) {
  const supabase = await createSupabaseServer()
  const { error } = await supabase.from('conversations').insert({
    id: chat.id,
    user_id: chat.userId,
    project_id: chat.projectId ?? null,
    title: chat.title,
  })
  if (error) {
    console.error('Error creating conversation:', error);
    throw error;
  }
}

export async function saveMessages(messages: UIMessage[], conversationId: string) {
  const supabase = await createSupabaseServer()

  const messagesToInsert = messages.map((message) => ({
    ...(isUuid(message.id) ? { id: message.id } : {}),
    conversation_id: conversationId,
    role: message.role,
    parts: message.parts,
    metadata: {
      ...((message as any).metadata || {}),
      ui_message_id: message.id,
    },
  }))

  const { data, error } = await supabase.from('messages').insert(messagesToInsert).select('id')

  if (error) {
    console.error('Error saving messages:', error)
    throw new Error('Could not save messages')
  }

  return data || []
}

export async function generateTitleFromUserMessage({
  message,
  model
}: {
  message: UIMessage;
  model: string;
}) {
  const text = message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ')
    .trim()

  const { text: title } = await generateText({
    model: myProvider.languageModel(model),
    system: [
      'You name chat threads in a video-analysis app, where users ask an assistant about their uploaded videos.',
      'You are given the first message of a thread. Do not answer or respond to it — only write a title for the thread.',
      'The title is 2-6 words in Title Case, says what the user wanted (e.g. "Man in White Shirt and Yellow Shorts", "Car Fire Moment", "Map Appearances"), and has no quotes, colons or trailing period.',
      'For a bare greeting, use "Greeting"; for asking what the assistant can do, use "Assistant Capabilities".',
    ].join(' '),
    prompt: `First message:\n<<<\n${text}\n>>>`,
  });

  return title.trim().replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 80) || 'New chat';
}

export async function updateChatTitle(chatId: string, title: string) {
  const supabase = await createSupabaseServer()
  const { error } = await supabase.from('conversations').update({ title }).eq('id', chatId)

  if (error) {
    console.error('Error updating chat title:', error)
  }
}

export async function updateChatUsage(chatId: string, usage: AppUsage) {
  const supabase = await createSupabaseServer()
  const { error } = await supabase
    .from('conversations')
    .update({ lastContext: usage })
    .eq('id', chatId)

  if (error) {
    console.error('Error updating chat usage:', error)
  }
}
