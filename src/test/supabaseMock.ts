import { vi } from 'vitest'

export type MockResult = { data: unknown; error: { code?: string; message?: string } | null; count?: number | null }

/**
 * A minimal stand-in for the supabase-js fluent query builder. Every
 * filter/select method returns itself so chains like
 * `.from().select().eq().eq().single()` type-check and run, and the
 * builder itself is thenable so `await query.order(...)` (no `.single()`)
 * also resolves - matching how supabase-js's real builder works.
 */
export type QueryBuilder = {
  select: (...args: unknown[]) => QueryBuilder
  insert: (...args: unknown[]) => QueryBuilder
  update: (...args: unknown[]) => QueryBuilder
  upsert: (...args: unknown[]) => QueryBuilder
  delete: (...args: unknown[]) => QueryBuilder
  eq: (...args: unknown[]) => QueryBuilder
  neq: (...args: unknown[]) => QueryBuilder
  or: (...args: unknown[]) => QueryBuilder
  lt: (...args: unknown[]) => QueryBuilder
  gte: (...args: unknown[]) => QueryBuilder
  is: (...args: unknown[]) => QueryBuilder
  in: (...args: unknown[]) => QueryBuilder
  limit: (...args: unknown[]) => QueryBuilder
  order: (...args: unknown[]) => QueryBuilder
  single: () => Promise<MockResult>
  maybeSingle: () => Promise<MockResult>
} & PromiseLike<MockResult>

export function createQueryBuilder(result: MockResult): QueryBuilder {
  const builder: QueryBuilder = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    upsert: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    neq: vi.fn(() => builder),
    or: vi.fn(() => builder),
    lt: vi.fn(() => builder),
    gte: vi.fn(() => builder),
    is: vi.fn(() => builder),
    in: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    order: vi.fn(() => builder),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
  }
  return builder
}

export function createSupabaseMock() {
  return {
    from: vi.fn(),
    rpc: vi.fn(),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    })),
    removeChannel: vi.fn(),
    realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
  }
}
