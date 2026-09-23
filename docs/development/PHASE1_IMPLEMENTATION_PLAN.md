# PHASE 1: CRITICAL FIXES - IMPLEMENTATION PLAN

## Priority Order

### TIER 1: SECURITY (BLOCKING)
These must be done FIRST or everything else is compromised.

#### 1.1 Row-Level Security (RLS) Policies
**Status:** ⚠️ REQUIRES SUPABASE CONFIGURATION (Not in git)
**Effort:** 8 hours
**Criticality:** P0 - BLOCKS ALL

**What needs to happen:**
```sql
-- profiles table: Users can only read their own + public fields
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- orders table: Users can only see their own orders (as customer or deliverer)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own orders"
  ON orders FOR SELECT
  USING (auth.uid() = customer_id OR auth.uid() = deliverer_id);

CREATE POLICY "Users can create orders"
  ON orders FOR INSERT
  WITH CHECK (auth.uid() = customer_id);

CREATE POLICY "Only assigned deliverer can update order status"
  ON orders FOR UPDATE
  USING (auth.uid() = deliverer_id);

-- chat_messages table: Users can only see chat in their orders
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view messages in their orders"
  ON chat_messages FOR SELECT
  USING (
    auth.uid() IN (
      SELECT customer_id FROM orders WHERE id = order_id
      UNION
      SELECT deliverer_id FROM orders WHERE id = order_id
    )
  );

-- friendships table: Users can only manage their own friendships
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their friendships"
  ON friendships FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() = friend_id);
```

**Action Required:** Manually execute these in Supabase SQL editor (or create migration file)

---

#### 1.2 Database Indexes
**Status:** ⚠️ REQUIRES SUPABASE CONFIGURATION (Not in git)
**Effort:** 1 hour
**Criticality:** P1 - Performance

```sql
CREATE INDEX orders_customer_id_idx ON orders(customer_id);
CREATE INDEX orders_deliverer_id_idx ON orders(deliverer_id);
CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX chat_messages_order_id_idx ON chat_messages(order_id);
CREATE INDEX chat_messages_created_at_idx ON chat_messages(created_at);
CREATE INDEX friendships_user_id_idx ON friendships(user_id);
```

---

### TIER 2: CORE FEATURES (BLOCKING)

#### 2.1 Implement Order Creation
**Status:** 🔴 TODO in code
**File:** `src/pages/PostRequest.tsx` line 75
**Effort:** 4 hours
**Criticality:** P0 - Feature completely broken

**Current:** handleSubmit is empty TODO
**Required:**
1. Validate form inputs (price, location, items)
2. Create order in Supabase
3. Handle errors (show toast)
4. Redirect to /my-orders on success
5. Prevent duplicate submission (disable button during request)

**Implementation approach:**
- Extract form validation to Zod schema
- Use async/await for order creation
- Add proper error handling
- Show loading state

---

#### 2.2 Authorization Checks
**Status:** 🔴 Missing everywhere
**Files:** 
- `src/hooks/useOrders.ts` - acceptOrder() has no auth check
- `src/pages/MyOrders.tsx` - No user validation
**Effort:** 6 hours
**Criticality:** P0 - Security

**Required checks:**

```typescript
// BEFORE accepting order:
if (order.status !== 'pending') {
  throw new Error('Can only accept pending orders');
}

// BEFORE updating order status:
const order = await fetchOrder(orderId);
if (order.deliverer_id !== currentUser.id) {
  throw new Error('Only assigned deliverer can update status');
}

// BEFORE viewing chat:
const order = await fetchOrder(orderId);
if (order.customer_id !== currentUser.id && order.deliverer_id !== currentUser.id) {
  throw new Error('Unauthorized');
}
```

**Files to update:**
- useOrders.ts - add authorization to acceptOrder(), updateOrderStatus()
- useChat.ts - add authorization to getMessages()
- Pages - validate user owns the data they're viewing

---

#### 2.3 Input Validation & Sanitization
**Status:** 🔴 Missing
**Files:** 
- `src/pages/Login.tsx`
- `src/pages/PostRequest.tsx`
- `src/pages/Profile.tsx`
**Effort:** 4 hours
**Criticality:** P0 - Security (XSS/Injection)

**Schema needed:**
```typescript
// Auth schemas
const LoginSchema = z.object({
  email: z.string().email('Invalid email').endsWith('@vitstudent.ac.in', 'Must use VIT email'),
  password: z.string().min(8, 'Password must be 8+ characters')
});

const SignupSchema = LoginSchema.extend({
  fullName: z.string().min(2).max(100),
  phone: z.string().regex(/^\+91\d{10}$/, 'Invalid Indian phone number')
});

// Order schemas
const PostOrderSchema = z.object({
  restaurant: z.string().min(1),
  items: z.string().min(1),
  price: z.number().min(10).max(10000),
  tip: z.number().min(0).max(1000),
  pickupLocation: z.string().min(5),
  deliveryLocation: z.string().min(5),
  distance: z.number().min(0.1).max(5)
});
```

**Implementation:**
- Install `zod` (already in package.json)
- Create `src/lib/validation.ts` with schemas
- Use in all forms with react-hook-form (already installed)
- Sanitize inputs before storing

---

### TIER 3: RELIABILITY

#### 3.1 Add Error Boundaries
**Status:** 🔴 Missing
**Effort:** 2 hours
**Criticality:** P0 - Prevents app crashes

**Create:** `src/components/ErrorBoundary.tsx`
- Catch React component errors
- Display fallback UI
- Log to error tracking (Sentry)

**Update:** `src/App.tsx` - wrap routes with ErrorBoundary

---

#### 3.2 Add Error Handling to Async Operations
**Status:** 🔴 Most async ops have no error handling
**Files:**
- `src/hooks/useOrders.ts` - fetchOrders(), acceptOrder()
- `src/hooks/useChat.ts` - sendMessage()
- `src/hooks/useAuth.ts` - signup()
**Effort:** 8 hours
**Criticality:** P0 - Prevents silent failures

**Pattern to implement:**
```typescript
try {
  const data = await supabase.from('orders').select();
  setOrders(data);
  setError(null);
} catch (err) {
  const message = err.message || 'Failed to fetch orders';
  setError(message);
  toast.error(message);
  // Log to Sentry
}
```

---

#### 3.3 Add Loading/Error States to Components
**Status:** 🔴 Most components missing states
**Files:**
- `src/pages/Home.tsx` - show skeleton while loading
- `src/pages/MyOrders.tsx` - show empty state
- `src/components/OrderCard.tsx` - disable button while loading
**Effort:** 4 hours
**Criticality:** P1 - UX

---

## Implementation Order

### Day 1: Database (2-3 hours)
- [ ] Create Supabase RLS policies (manual in console)
- [ ] Create indexes (manual in console)
- [ ] Document what was done

### Day 2-3: Frontend Core (12 hours)
- [ ] Implement order creation in PostRequest.tsx
- [ ] Add authorization checks to useOrders.ts
- [ ] Add input validation schemas
- [ ] Add error boundaries

### Day 4: Error Handling (8 hours)
- [ ] Add try/catch to all async operations
- [ ] Add loading/error states to components
- [ ] Update toast notifications

### Day 5: Testing & Polish (4 hours)
- [ ] Manual testing of order flow
- [ ] Test authorization (try to accept order you don't own)
- [ ] Test error scenarios

---

## Files to Create/Modify

### Create:
- `src/lib/validation.ts` - Zod schemas
- `src/components/ErrorBoundary.tsx` - Error boundary component
- `src/components/EmptyState.tsx` - Empty state component
- `SUPABASE_SETUP.md` - RLS & index setup instructions

### Modify:
- `src/pages/PostRequest.tsx` - implement handleSubmit
- `src/hooks/useOrders.ts` - add auth checks, error handling
- `src/hooks/useAuth.ts` - add validation, error handling
- `src/hooks/useChat.ts` - add auth checks
- `src/pages/Home.tsx` - add loading states
- `src/pages/MyOrders.tsx` - add error handling
- `src/App.tsx` - wrap with ErrorBoundary
- `src/pages/Login.tsx` - add validation

---

## Success Criteria for Phase 1

- [ ] Orders can be created successfully
- [ ] Users cannot see other users' data
- [ ] Users cannot modify orders they don't own
- [ ] All async operations have error handling
- [ ] App shows meaningful error messages (not crashes)
- [ ] Form inputs are validated before submission
- [ ] XSS vulnerability fixed (inputs sanitized)

---

## Next Phase (After Phase 1)

1. Rate limiting on auth endpoints
2. Email verification flow
3. Phone verification
4. Payment/tipping system
5. OTP for delivery confirmation
6. Monitoring setup (Sentry, Datadog)
7. CI/CD pipeline
8. Automated tests
