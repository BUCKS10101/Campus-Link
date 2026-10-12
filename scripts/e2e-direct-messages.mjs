#!/usr/bin/env node
/**
 * Direct-message (friend chat) verification against a STAGING Supabase
 * project, using ordinary user sessions through the anon key - the same
 * path the app uses. Run it after applying
 * supabase/migrations/20261013100000_direct_messages.sql to staging.
 *
 * SAFETY (same rules as scripts/e2e-staging.mjs):
 *   - Refuses to run against the production project ref.
 *   - Anon key + user sessions only; no service-role key, no DB password.
 *   - Creates tagged disposable accounts. Cleanup is best-effort: accounts
 *     cannot be deleted with the anon key, so they remain (tagged with the
 *     run id) and can be removed from the dashboard.
 *
 * REQUIRES staging with "Confirm email" OFF (so signups get a session and
 * count as verified). NOT covered here - needs elevated access, test by
 * hand in the SQL editor: an UNVERIFIED sender is rejected (set
 * auth.users.email_confirmed_at = null for a test user, then insert).
 *
 * USAGE: node scripts/e2e-direct-messages.mjs
 * Reads credentials from .env.staging.local (git-ignored).
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'kjsseqlmnmiuqepfmldh'

const fail = (msg) => {
  console.error(`\n  FATAL: ${msg}\n`)
  process.exit(1)
}

const env = {}
try {
  for (const line of readFileSync('.env.staging.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].trim()
  }
} catch {
  fail('Missing .env.staging.local')
}
const URL = env.VITE_SUPABASE_URL
const ANON = env.VITE_SUPABASE_ANON_KEY
if (!URL || !ANON) fail('.env.staging.local is missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.')
if (URL.includes(PRODUCTION_REF)) fail('REFUSING TO RUN against the PRODUCTION project.')

const results = []
const check = (desc, passed, detail = '') => {
  results.push(passed)
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${desc}${detail ? `\n         ${detail}` : ''}`)
}
/** A rejection is an error, or a write that affected nothing. Never a silent success. */
const rejected = (r) => Boolean(r.error) || (Array.isArray(r.data) ? r.data.length === 0 : !r.data)

const RUN_ID = `dm${Date.now().toString(36)}`
const PASSWORD = `Test-${RUN_ID}-Aa1!`
const client = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } })

async function account(role) {
  const email = `${RUN_ID}-${role}@vitstudent.ac.in`
  const sb = client()
  const { data, error } = await sb.auth.signUp({ email, password: PASSWORD })
  if (error) fail(`signup ${role}: ${error.message}`)
  if (!data.session) fail('No session on signup - turn OFF "Confirm email" on staging, then re-run.')
  const { error: pErr } = await sb.from('profiles').insert([{ id: data.user.id, name: `E2E ${role}`, email, phone: '9876543210' }])
  if (pErr) fail(`profile ${role}: ${pErr.message}`)
  return { id: data.user.id, sb }
}

async function befriend(a, b) {
  const { data: fid, error } = await a.sb.rpc('send_friend_request', { p_addressee_id: b.id })
  if (error) fail(`friend request: ${error.message}`)
  const { error: aErr } = await b.sb.rpc('accept_friend_request', { p_friendship_id: fid })
  if (aErr) fail(`accept: ${aErr.message}`)
  return fid
}

async function main() {
  console.log(`\nDirect messages E2E - staging: ${URL}\nRun: ${RUN_ID}\n`)
  const alice = await account('alice')
  const bob = await account('bob')
  const carol = await account('carol') // never a friend of alice/bob
  const friendshipId = await befriend(alice, bob)

  console.log('Conversations')
  const c1 = await alice.sb.rpc('get_or_create_direct_conversation', { p_friend_id: bob.id })
  const c2 = await bob.sb.rpc('get_or_create_direct_conversation', { p_friend_id: alice.id })
  const c3 = await alice.sb.rpc('get_or_create_direct_conversation', { p_friend_id: bob.id })
  check('friends get a conversation', !c1.error && !!c1.data, c1.error?.message)
  check('the same conversation is reused from either side, repeatedly', c1.data === c2.data && c1.data === c3.data)
  const convId = c1.data
  const nonFriend = await alice.sb.rpc('get_or_create_direct_conversation', { p_friend_id: carol.id })
  check('a non-friend conversation is rejected', !!nonFriend.error, nonFriend.error?.message)
  const self = await alice.sb.rpc('get_or_create_direct_conversation', { p_friend_id: alice.id })
  check('a conversation with yourself is rejected', !!self.error, self.error?.message)

  console.log('Messages: persistence and authorization')
  const sent = await alice.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: alice.id, body: 'hello bob' }).select('*').single()
  check('a friend can send', !sent.error && sent.data?.body === 'hello bob', sent.error?.message)
  check('the database set the recipient', sent.data?.recipient_id === bob.id)
  check('read_at starts empty', sent.data?.read_at === null)

  const bobSees = await bob.sb.from('direct_messages').select('*').eq('conversation_id', convId).order('created_at')
  check('the recipient loads the persisted history', bobSees.data?.length === 1 && bobSees.data[0].body === 'hello bob', bobSees.error?.message)

  const carolMsgs = await carol.sb.from('direct_messages').select('*').eq('conversation_id', convId)
  const carolConvs = await carol.sb.from('direct_conversations').select('*').eq('id', convId)
  check('an outsider cannot read the messages', !carolMsgs.error && carolMsgs.data.length === 0)
  check('an outsider cannot read the conversation', !carolConvs.error && carolConvs.data.length === 0)
  const carolSend = await carol.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: carol.id, body: 'intruder' }).select('*')
  check('an outsider cannot send into it', rejected(carolSend), carolSend.error?.message)

  const spoof = await alice.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: bob.id, body: 'as bob' }).select('*')
  check('sender cannot be spoofed', rejected(spoof), spoof.error?.message)
  const protectedCols = await alice.sb
    .from('direct_messages')
    .insert({ conversation_id: convId, sender_id: alice.id, body: 'x', recipient_id: carol.id, read_at: new Date().toISOString(), created_at: '2020-01-01' })
    .select('*')
  check('recipient_id / read_at / created_at cannot be supplied', rejected(protectedCols), protectedCols.error?.message)
  const edit = await alice.sb.from('direct_messages').update({ body: 'edited' }).eq('id', sent.data.id).select('*')
  check('messages cannot be edited by clients', rejected(edit), edit.error?.message)
  const del = await alice.sb.from('direct_messages').delete().eq('id', sent.data.id).select('*')
  check('messages cannot be deleted by clients', rejected(del), del.error?.message)

  console.log('Read status')
  const before = await alice.sb.rpc('get_my_direct_conversations')
  const bobBefore = await bob.sb.rpc('get_my_direct_conversations')
  check('recipient sees 1 unread, sender sees 0', bobBefore.data?.[0]?.unread_count === 1 && before.data?.[0]?.unread_count === 0)
  await bob.sb.rpc('mark_direct_conversation_read', { p_conversation_id: convId })
  const bobAfter = await bob.sb.rpc('get_my_direct_conversations')
  check('marking read clears the unread count', bobAfter.data?.[0]?.unread_count === 0)
  const aliceMarksOwn = await alice.sb.rpc('mark_direct_conversation_read', { p_conversation_id: convId })
  check('marking your own sent messages read does nothing', !aliceMarksOwn.error)

  console.log('Realtime')
  const got = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000)
    bob.sb
      .channel(`e2e:${convId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${convId}` }, (p) => {
        clearTimeout(timer)
        resolve(p.new)
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          void alice.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: alice.id, body: 'live!' })
        }
      })
  })
  const live = await got
  check('bob receives alice\'s message over realtime without refetching', live?.body === 'live!')
  await bob.sb.removeAllChannels()

  console.log('Rate limit under concurrency (limit: 30 per 10 min per conversation)')
  const already = 2 // 'hello bob' + 'live!'
  const burst = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      bob.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: bob.id, body: `burst ${i}` }).select('id'),
    ),
  )
  const ok = burst.filter((r) => !r.error).length
  check('exactly 30 of 40 simultaneous sends succeed (bob had sent 0 before)', ok === 30, `succeeded: ${ok} (alice's ${already} earlier sends are a separate per-user count)`)

  console.log('Blocking')
  const dave = await account('dave')
  const erin = await account('erin')
  await befriend(dave, erin)
  const de = (await dave.sb.rpc('get_or_create_direct_conversation', { p_friend_id: erin.id })).data
  await dave.sb.rpc('block_user', { p_blocked_id: erin.id })
  const blockedSend = await erin.sb.from('direct_messages').insert({ conversation_id: de, sender_id: erin.id, body: 'hi' }).select('*')
  const blockerSend = await dave.sb.from('direct_messages').insert({ conversation_id: de, sender_id: dave.id, body: 'hi' }).select('*')
  check('a blocked user cannot send', rejected(blockedSend), blockedSend.error?.message)
  check('the blocker cannot send either', rejected(blockerSend), blockerSend.error?.message)

  console.log('Unfriending')
  const { error: rmErr } = await alice.sb.rpc('remove_friend', { p_friendship_id: friendshipId })
  check('remove_friend succeeds', !rmErr, rmErr?.message)
  const afterRemove = await bob.sb.from('direct_messages').insert({ conversation_id: convId, sender_id: bob.id, body: 'still there?' }).select('*')
  check('new messages are rejected after unfriending', rejected(afterRemove), afterRemove.error?.message)
  const history = await bob.sb.from('direct_messages').select('id').eq('conversation_id', convId)
  check('history is still readable after unfriending', (history.data?.length ?? 0) >= 1)
  const summary = await bob.sb.rpc('get_my_direct_conversations')
  check('the conversation is flagged read-only (can_message = false)', summary.data?.find((c) => c.conversation_id === convId)?.can_message === false)

  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} checks passed (run ${RUN_ID}; test accounts remain on staging, tagged with the run id)\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => fail(e.stack || String(e)))
