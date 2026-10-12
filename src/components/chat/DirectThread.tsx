import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertCircle } from 'lucide-react'
import { useDirectMessages } from '@/hooks/useDirectMessages'
import { useToast } from '@/hooks/use-toast'
import { Text } from '@/components/primitives'
import { cn, getErrorMessage } from '@/lib/utils'

export interface DirectThreadProps {
  conversationId: string
  currentUserId: string
  friendName: string
  /** False once the friendship is gone or a block exists - history stays readable. */
  canMessage: boolean
  emailVerified?: boolean
  onRead?: () => void
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { hour: 'numeric', minute: 'numeric', month: 'short', day: 'numeric' })

/** A private, persistent conversation between two friends (not order chat). */
export function DirectThread({
  conversationId,
  currentUserId,
  friendName,
  canMessage,
  emailVerified = true,
  onRead,
}: DirectThreadProps) {
  const { messages, loading, error, hasMore, loadingOlder, status, sendMessage, loadOlder, refetch } =
    useDirectMessages(conversationId, currentUserId, onRead)
  const { toast } = useToast()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const lastId = messages.at(-1)?.id

  // Follow new messages to the bottom; loading older history (which only
  // changes the first id) does not move the view.
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [lastId])

  const handleSend = async () => {
    if (!draft.trim() || sending || !canMessage || !emailVerified) return
    setSending(true)
    try {
      await sendMessage(draft)
      setDraft('')
    } catch (err) {
      // The draft stays in the composer so the user can retry.
      toast({ title: "Couldn't send", description: getErrorMessage(err, 'Please try again.'), variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-[24rem] flex-col">
      <div className="flex items-baseline justify-between gap-3 border-b-2 border-foreground pb-3">
        <Text variant="h3" as="div" className="truncate">{friendName}</Text>
        {status === 'reconnecting' && (
          <Text variant="caption" tone="faint" role="status">Reconnecting…</Text>
        )}
      </div>

      <div
        role="log"
        aria-live="polite"
        aria-label={`Conversation with ${friendName}`}
        className="mt-4 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        {hasMore && !loading && (
          <Button variant="ghost" size="sm" className="self-center" onClick={loadOlder} loading={loadingOlder}>
            Load earlier messages
          </Button>
        )}

        {loading && (
          <div className="flex flex-col gap-3" aria-hidden="true">
            <Skeleton className="h-10 w-3/5" />
            <Skeleton className="ml-auto h-10 w-2/5" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        )}

        {error && !loading && (
          <div className="m-auto flex flex-col items-center gap-3 text-center">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>Try again</Button>
          </div>
        )}

        {!loading && !error && messages.length === 0 && (
          <div className="m-auto max-w-[34ch] text-center">
            <Text variant="body" tone="muted" accent>{`This is the start of your chat with ${friendName}. Say hello.`}</Text>
          </div>
        )}

        {!loading && !error && messages.map((msg) => {
          const mine = msg.sender_id === currentUserId
          return (
            <div key={msg.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap break-words px-3.5 py-2.5',
                  mine ? 'rounded-md bg-primary-soft' : 'border-l-2 border-border pl-3.5',
                )}
                data-testid={mine ? 'dm-sent' : 'dm-received'}
              >
                <Text variant="body">{msg.body}</Text>
                <Text variant="caption" tone="faint" as="p" className="mt-1">
                  {formatTime(msg.created_at)}
                  {mine && msg.read_at ? ' · Read' : ''}
                </Text>
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {!canMessage && (
        <Text variant="caption" tone="muted" as="p" className="mt-3" role="status">
          You can only message accepted friends. This conversation is read-only.
        </Text>
      )}
      {canMessage && !emailVerified && (
        <Text variant="caption" tone="danger" as="p" className="mt-3" role="alert">
          Verify your email to send messages. <a href="/verify-email" className="underline underline-offset-4">Resend verification</a>
        </Text>
      )}

      <div className="mt-4 flex items-end gap-2">
        <label htmlFor={`dm-composer-${conversationId}`} className="sr-only">Message</label>
        <Input
          id={`dm-composer-${conversationId}`}
          placeholder="Message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          maxLength={1000}
          disabled={sending || !canMessage}
        />
        <Button onClick={handleSend} loading={sending} disabled={!draft.trim() || !canMessage || !emailVerified} size="sm">
          Send
        </Button>
      </div>
    </div>
  )
}
