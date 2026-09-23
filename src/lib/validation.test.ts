import { describe, it, expect } from 'vitest'
import {
  LoginSchema,
  SignupSchema,
  PostOrderSchema,
  ProfileUpdateSchema,
  ChatMessageSchema,
  OtpCodeSchema,
  RatingSchema,
  validateOrThrow,
} from './validation'

describe('LoginSchema', () => {
  it('accepts a valid VIT email/password', () => {
    expect(LoginSchema.safeParse({ email: 'a@vitstudent.ac.in', password: 'x' }).success).toBe(true)
  })

  it('accepts non-VIT emails (domain restriction currently disabled)', () => {
    const result = LoginSchema.safeParse({ email: 'a@b.com', password: 'x' })
    expect(result.success).toBe(true)
  })

  it('rejects an invalid email', () => {
    const result = LoginSchema.safeParse({ email: 'not-an-email', password: 'x' })
    expect(result.success).toBe(false)
  })

  it('rejects an empty password', () => {
    const result = LoginSchema.safeParse({ email: 'a@vitstudent.ac.in', password: '' })
    expect(result.success).toBe(false)
  })
})

describe('SignupSchema', () => {
  const valid = { fullName: 'Jane Doe', email: 'jane@vitstudent.ac.in', phone: '9876543210', password: 'password123' }

  it('accepts valid signup data', () => {
    expect(SignupSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts non-VIT emails (domain restriction currently disabled)', () => {
    expect(SignupSchema.safeParse({ ...valid, email: 'jane@gmail.com' }).success).toBe(true)
  })

  it('rejects a short password', () => {
    expect(SignupSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
  })

  it('rejects a phone number that is not 10 digits', () => {
    expect(SignupSchema.safeParse({ ...valid, phone: '123' }).success).toBe(false)
    expect(SignupSchema.safeParse({ ...valid, phone: '12345678901' }).success).toBe(false)
  })

  it('rejects a one-character full name', () => {
    expect(SignupSchema.safeParse({ ...valid, fullName: 'J' }).success).toBe(false)
  })
})

describe('PostOrderSchema', () => {
  // Matches the live schema: orders.requester_id (not customer_id),
  // items/delivery_location as jsonb (not items_description/pickup_location
  // as strings), distance_km (not distance). No price/restaurant_icon/
  // completed_at - those columns don't exist live.
  const valid = {
    requester_id: '11111111-1111-1111-1111-111111111111',
    deliverer_id: null,
    restaurant_name: 'One Food',
    items: ['2x Chicken Burger', '1x Fries'],
    tip_amount: 30,
    delivery_location: { type: 'hostel' as const, label: "Men's Hostel K", hostelType: 'mens' as const, block: 'K' },
    distance_km: 1.2,
    pickup_point_id: '22222222-2222-2222-2222-222222222222',
    delivery_point_id: '33333333-3333-3333-3333-333333333333',
    custom_delivery_lat: null,
    custom_delivery_lng: null,
    custom_delivery_note: null,
    distance_source: 'routed' as const,
    status: 'pending' as const,
  }

  it('accepts a valid order', () => {
    expect(PostOrderSchema.safeParse(valid).success).toBe(true)
  })

  it('accepts null distance_km/pickup_point_id/delivery_point_id (unseeded campus points)', () => {
    expect(PostOrderSchema.safeParse({
      ...valid,
      distance_km: null,
      pickup_point_id: null,
      delivery_point_id: null,
      distance_source: null,
    }).success).toBe(true)
  })

  it('accepts every distance_source value, including null for legacy/unresolved orders', () => {
    expect(PostOrderSchema.safeParse({ ...valid, distance_source: 'routed' }).success).toBe(true)
    expect(PostOrderSchema.safeParse({ ...valid, distance_source: 'fallback' }).success).toBe(true)
    expect(PostOrderSchema.safeParse({ ...valid, distance_source: 'unresolved' }).success).toBe(true)
    expect(PostOrderSchema.safeParse({ ...valid, distance_source: null }).success).toBe(true)
  })

  it('rejects an invalid distance_source value', () => {
    expect(PostOrderSchema.safeParse({ ...valid, distance_source: 'guessed' }).success).toBe(false)
  })

  it('rejects a non-uuid delivery_point_id', () => {
    expect(PostOrderSchema.safeParse({ ...valid, delivery_point_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('accepts a custom pin (lat/lng/note) in place of delivery_point_id', () => {
    const result = PostOrderSchema.safeParse({
      ...valid,
      delivery_point_id: null,
      custom_delivery_lat: 12.9705,
      custom_delivery_lng: 79.1601,
      custom_delivery_note: 'Outside TT Tower, near the north entrance',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an out-of-range custom_delivery_lat', () => {
    expect(PostOrderSchema.safeParse({ ...valid, custom_delivery_lat: 999 }).success).toBe(false)
  })

  it('rejects a custom_delivery_note over 300 characters', () => {
    expect(PostOrderSchema.safeParse({ ...valid, custom_delivery_note: 'x'.repeat(301) }).success).toBe(false)
  })

  it('rejects an empty items array', () => {
    expect(PostOrderSchema.safeParse({ ...valid, items: [] }).success).toBe(false)
  })

  it('rejects an items array with a blank line', () => {
    expect(PostOrderSchema.safeParse({ ...valid, items: [''] }).success).toBe(false)
  })

  it('rejects a tip below the ₹10 minimum', () => {
    expect(PostOrderSchema.safeParse({ ...valid, tip_amount: 5 }).success).toBe(false)
  })

  it('rejects a delivery_location missing a label', () => {
    expect(PostOrderSchema.safeParse({ ...valid, delivery_location: { type: 'campus', label: '' } }).success).toBe(false)
  })

  it('rejects a delivery_location that is a plain string (must be the jsonb shape)', () => {
    expect(PostOrderSchema.safeParse({ ...valid, delivery_location: "Men's Hostel K" }).success).toBe(false)
  })

  it('rejects a non-uuid requester_id', () => {
    expect(PostOrderSchema.safeParse({ ...valid, requester_id: 'not-a-uuid' }).success).toBe(false)
  })

  it('accepts a campus delivery location without hostel fields', () => {
    expect(PostOrderSchema.safeParse({ ...valid, delivery_location: { type: 'campus', label: 'TT Block' } }).success).toBe(true)
  })
})

describe('ProfileUpdateSchema', () => {
  it('accepts a partial update with just a name', () => {
    expect(ProfileUpdateSchema.safeParse({ name: 'New Name' }).success).toBe(true)
  })

  it('accepts an empty update', () => {
    expect(ProfileUpdateSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a malformed phone number', () => {
    expect(ProfileUpdateSchema.safeParse({ phone: 'abc' }).success).toBe(false)
  })
})

describe('ChatMessageSchema', () => {
  it('accepts a normal message', () => {
    expect(ChatMessageSchema.safeParse({ message: 'On my way!' }).success).toBe(true)
  })

  it('rejects an empty/whitespace-only message', () => {
    expect(ChatMessageSchema.safeParse({ message: '   ' }).success).toBe(false)
  })

  it('rejects a message over 1000 characters', () => {
    expect(ChatMessageSchema.safeParse({ message: 'a'.repeat(1001) }).success).toBe(false)
  })
})

describe('OtpCodeSchema', () => {
  it('accepts a 6-digit code', () => {
    expect(OtpCodeSchema.safeParse('123456').success).toBe(true)
  })

  it('rejects a code with letters or the wrong length', () => {
    expect(OtpCodeSchema.safeParse('12a456').success).toBe(false)
    expect(OtpCodeSchema.safeParse('1234').success).toBe(false)
  })
})

describe('RatingSchema', () => {
  it('accepts a score with no comment', () => {
    expect(RatingSchema.safeParse({ score: 5 }).success).toBe(true)
  })

  it('accepts a score with a short comment', () => {
    expect(RatingSchema.safeParse({ score: 4, comment: 'Fast and careful!' }).success).toBe(true)
  })

  it('accepts an empty-string comment (treated as no comment)', () => {
    expect(RatingSchema.safeParse({ score: 3, comment: '' }).success).toBe(true)
  })

  it('rejects a score of 0 or below 1', () => {
    expect(RatingSchema.safeParse({ score: 0 }).success).toBe(false)
  })

  it('rejects a score above 5', () => {
    expect(RatingSchema.safeParse({ score: 6 }).success).toBe(false)
  })

  it('rejects a non-integer score', () => {
    expect(RatingSchema.safeParse({ score: 4.5 }).success).toBe(false)
  })

  it('rejects a comment over 300 characters', () => {
    expect(RatingSchema.safeParse({ score: 5, comment: 'a'.repeat(301) }).success).toBe(false)
  })

  it('accepts a comment at exactly 300 characters', () => {
    expect(RatingSchema.safeParse({ score: 5, comment: 'a'.repeat(300) }).success).toBe(true)
  })
})

describe('validateOrThrow', () => {
  it('returns the parsed value on success', () => {
    expect(validateOrThrow(LoginSchema, { email: 'a@vitstudent.ac.in', password: 'x' })).toEqual({ email: 'a@vitstudent.ac.in', password: 'x' })
  })

  it('throws an Error with the first issue message on failure', () => {
    expect(() => validateOrThrow(LoginSchema, { email: 'bad', password: 'x' })).toThrow()
  })
})
