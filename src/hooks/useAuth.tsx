import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { User } from '@supabase/supabase-js'
import { useTheme } from 'next-themes'
import { supabase } from '@/lib/supabase'
import type { Profile } from '@/lib/database-types'
import { SignupSchema, LoginSchema, ProfileUpdateSchema, ChangePasswordSchema, ForgotPasswordSchema, ResetPasswordSchema, validateOrThrow } from '@/lib/validation'

export interface AuthUser {
  user: User
  profile: Profile | null
  /**
   * Phase 3J - see PHASE3_3J_TRUST_SAFETY_SPEC.md §2. Purely derived from
   * the Supabase-native session.user.email_confirmed_at field (already
   * present on every session, unread by any code before 3J) - not a new
   * DB column, not a second identity system. null/undefined means "never
   * confirmed"; any timestamp means confirmed, once, permanently (a
   * BEFORE INSERT trigger only rejects new signups from the wrong
   * domain - it has no bearing on this field).
   */
  emailVerified: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  signUp: (email: string, password: string, userData: { fullName: string; phone: string }) => Promise<unknown>
  signIn: (email: string, password: string) => Promise<unknown>
  signOut: () => Promise<void>
  updateProfile: (updates: Partial<Profile>) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string, confirmPassword: string) => Promise<void>
  sendPasswordResetEmail: (email: string) => Promise<void>
  updatePasswordAfterReset: (newPassword: string, confirmPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  // Light mode is the default for every new login session. A theme chosen
  // during a session lives in next-themes (and survives reloads), and is
  // reset here on sign-in and sign-out - including a different account
  // signing in on the same browser. Held in a ref because the auth
  // listener below is registered once and must not capture a stale setter.
  const { setTheme } = useTheme()
  const resetThemeRef = useRef(() => setTheme('light'))
  resetThemeRef.current = () => setTheme('light')

  useEffect(() => {
    // Supabase can legitimately emit more than one state-change event for
    // the same already-signed-in user right after a fresh load (an
    // INITIAL_SESSION followed by a near-expiry TOKEN_REFRESHED, for
    // instance) - without this guard each one re-fetches the profile.
    // Tracked outside React state since it must be readable synchronously
    // from inside the event callback below, not just after a re-render.
    let fetchedForUserId: string | null = null

    const fetchUserProfile = async (authUser: User) => {
      fetchedForUserId = authUser.id
      try {
        let { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', authUser.id)
          .single()

        // Self-heal a missing profile row (PGRST116 = no row found), rather
        // than just logging it and leaving the account permanently broken.
        // Root cause: signUp()'s own profile insert (below) runs
        // IMMEDIATELY after supabase.auth.signUp() returns - but when
        // Confirm Email is on (as it now is on production), signUp() does
        // NOT return a live session, so that insert executes unauthenticated
        // and profiles_insert_own's `auth.uid() = id` RLS check silently
        // rejects it (caught only by console.error, never surfaced or
        // retried). This is the first point afterward where a REAL session
        // definitely exists (fetchUserProfile only ever runs from
        // onAuthStateChange with an actual session) - auth.uid() correctly
        // resolves here, so the same insert that failed at signup time will
        // succeed now. Uses signUp()'s own metadata (full_name/phone,
        // already stored on the auth user regardless of whether the
        // profile insert succeeded) so no data is lost - the user never
        // re-enters anything.
        if (error && error.code === 'PGRST116') {
          const metadata = authUser.user_metadata as { full_name?: string; phone?: string } | null
          const { data: created, error: createError } = await supabase
            .from('profiles')
            .insert([{
              id: authUser.id,
              name: metadata?.full_name || authUser.email?.split('@')[0] || 'CampusLink user',
              email: authUser.email || '',
              phone: metadata?.phone || null,
            }])
            .select('*')
            .single()

          if (createError) {
            console.error('Error self-healing missing profile:', createError)
          } else {
            profile = created
            error = null
          }
        }

        if (error && error.code !== 'PGRST116') {
          console.error('Error fetching profile:', error)
        }

        setUser({ user: authUser, profile, emailVerified: authUser.email_confirmed_at != null })
      } catch (error) {
        console.error('Error fetching profile:', error)
      } finally {
        setLoading(false)
      }
    }

    // A single shared listener for the whole app - one component instance
    // used to mean one supabase.auth.getSession() + one onAuthStateChange
    // subscription PER useAuth() caller, so a page with three consumers
    // (ProtectedRoute, the nav's AccountMenu, the page itself) fired the
    // profile fetch three times over. This provider is the one place that
    // does it now; useAuth() below just reads the shared result.
    //
    // The callback itself must not be `async`/await anything that re-enters
    // the supabase client (fetchUserProfile -> supabase.from(...) -> that
    // call internally awaits auth.getSession()). Supabase's own
    // initialize() holds an internal lock for the full duration of emitting
    // this event on a fresh page load with an already-persisted session; a
    // synchronous re-entrant call inside the callback ends up awaiting that
    // same still-open initialize() promise, which never resolves because
    // it's waiting on this callback to return - a permanent hang with zero
    // network activity. Deferring the re-entrant work to a macrotask lets
    // initialize() finish and release the lock first; this is Supabase's
    // own documented workaround for the deadlock (see GoTrueClient's
    // initialize()/_recoverAndRefresh()).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => {
        if (session?.user) {
          // A genuinely new sign-in (not a token refresh or a tab-focus
          // re-emit for the user already loaded) starts in light mode.
          if (_event === 'SIGNED_IN' && fetchedForUserId !== session.user.id) {
            resetThemeRef.current()
          }
          if (fetchedForUserId === session.user.id) {
            // Same user as before - skip the profile re-fetch (the
            // guard this comment sits above exists for), but still
            // refresh the raw `user` object itself. Phase 3J: this is
            // what lets emailVerified flip from false to true after a
            // real confirmation-link click without a full page reload -
            // Supabase emits a fresh session.user (new
            // email_confirmed_at) on that event, and the old code here
            // discarded it entirely for an already-fetched user id.
            setUser((prev) => (prev
              ? { ...prev, user: session.user, emailVerified: session.user.email_confirmed_at != null }
              : prev))
            return
          }
          void fetchUserProfile(session.user)
        } else {
          fetchedForUserId = null
          resetThemeRef.current()
          setUser(null)
          setLoading(false)
        }
      }, 0)
    })

    return () => subscription.unsubscribe()
  }, [])

  const signUp = async (email: string, password: string, userData: { fullName: string; phone: string }) => {
    const validated = validateOrThrow(SignupSchema, {
      email,
      password,
      fullName: userData.fullName,
      phone: userData.phone,
    })

    const { data, error } = await supabase.auth.signUp({
      email: validated.email,
      password: validated.password,
      options: {
        data: {
          full_name: validated.fullName,
          phone: validated.phone,
        },
      },
    })

    if (error) throw error

    // Create profile. is_deliverer/total_deliveries/friend_count/avatar_url
    // don't exist on the live profiles table - anyone can be a deliverer
    // for someone else's order regardless of any flag (matches the orders
    // RLS policies, which never check such a flag either). rating/
    // successful_deliveries/balance all have DB defaults (0/0.0/0.0), so
    // they're left for Postgres to set rather than duplicated here.
    if (data.user) {
      const { error: profileError } = await supabase.from('profiles').insert([{
        id: data.user.id,
        name: validated.fullName,
        email: validated.email,
        phone: validated.phone,
      }] as any)

      if (profileError) {
        console.error('Error creating profile:', profileError)
      }
    }

    return data
  }

  const signIn = async (email: string, password: string) => {
    const validated = validateOrThrow(LoginSchema, { email, password })

    const { data, error } = await supabase.auth.signInWithPassword({
      email: validated.email,
      password: validated.password,
    })

    if (error) throw error
    resetThemeRef.current()
    return data
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    resetThemeRef.current()
  }

  const updateProfile = async (updates: Partial<Profile>) => {
    if (!user?.user) throw new Error('No user logged in')

    const validated = validateOrThrow(ProfileUpdateSchema, updates)

    const { error } = await (supabase as any)
      .from('profiles')
      .update(validated)
      .eq('id', user.user.id)

    if (error) throw error

    const { data: profile, error: fetchError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.user.id)
      .single()

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('Error refreshing profile:', fetchError)
    }

    setUser({ user: user.user, profile, emailVerified: user.emailVerified })
  }

  // Requires re-proving the current password (via a real sign-in call,
  // not a client-side comparison against anything cached) before issuing
  // the update - Supabase's updateUser() would otherwise accept a new
  // password from anyone holding an already-open session, with no check
  // that they actually know the old one.
  const changePassword = async (currentPassword: string, newPassword: string, confirmPassword: string) => {
    if (!user?.user.email) throw new Error('No user logged in')

    const validated = validateOrThrow(ChangePasswordSchema, { currentPassword, newPassword, confirmPassword })

    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user.user.email,
      password: validated.currentPassword,
    })
    if (reauthError) throw new Error('Current password is incorrect.')

    const { error } = await supabase.auth.updateUser({ password: validated.newPassword })
    if (error) throw error
  }

  // QA audit AUTH-09: no forgot-password flow existed anywhere in the app
  // (confirmed by full-repo search). Rides entirely on Supabase's own
  // recovery-email mechanism, same "no custom token system" discipline
  // as 3J's email verification - resetPasswordForEmail() sends a link
  // that, once clicked, gives the browser a real (if recovery-scoped)
  // session via Supabase's own detectSessionInUrl handling; this call
  // itself never reveals whether the email exists (Supabase's response
  // shape is deliberately the same either way, mirroring signUp()'s own
  // anti-enumeration behavior - see the signUp() comment above).
  const sendPasswordResetEmail = async (email: string) => {
    const validated = validateOrThrow(ForgotPasswordSchema, { email })
    const { error } = await supabase.auth.resetPasswordForEmail(validated.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    if (error) throw error
  }

  // Called from the /reset-password page, which is only reachable with a
  // real (recovery) session already established by Supabase's own
  // detectSessionInUrl handling of the emailed link - no separate
  // "current password" re-proof is needed or possible here (that's
  // exactly the case a forgotten password can't satisfy), unlike
  // changePassword() above which requires it.
  const updatePasswordAfterReset = async (newPassword: string, confirmPassword: string) => {
    const validated = validateOrThrow(ResetPasswordSchema, { newPassword, confirmPassword })
    const { error } = await supabase.auth.updateUser({ password: validated.newPassword })
    if (error) throw error
  }

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signOut, updateProfile, changePassword, sendPasswordResetEmail, updatePasswordAfterReset }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
