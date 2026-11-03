import { getValidSession } from './sessions'
import { getBillingStatus, isBillingEnabled, startUserTrial, TRIAL_DURATION_DAYS } from '../core/billing'
import {
  getProgressionStatus,
  claimMission,
  equipCosmetic,
  MISSIONS,
  COSMETIC_ITEMS,
  STORYLINE,
} from '../core/progression'
import { createStripeBilling, BillingError } from './stripe'

const PUBLIC_PLANS = {
  free: {
    name: 'Free Explorer',
    price: 0,
    description: 'Explore the Grid, chat, complete missions and unlock cosmetics. Free forever.',
  },
  trial: {
    name: 'Architect Trial',
    durationDays: TRIAL_DURATION_DAYS,
    description: '14 days of builder access: place, move and script apps in the world.',
  },
  pro: {
    name: 'Architect Pro',
    price: 15,
    period: 'monthly',
    description: 'Keep builder access after your trial. Cancel anytime.',
  },
}

const limit = max => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } })

export async function registerMonetizationRoutes(fastify, { db, world }) {
  const billingEnabled = isBillingEnabled()
  const billing = createStripeBilling({
    db,
    onUserUpdated: user => world.network.onUserBillingUpdated?.(user),
  })

  // Resolve identity only from a persisted, non-revoked session.
  async function getSessionContext(req) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return null
    const valid = await getValidSession(db, token)
    if (!valid) return null
    const live = world.network.getLiveUser?.(valid.payload.userId)
    const user = live || (await db('users').where('id', valid.payload.userId).first())
    return user ? { user, session: valid.session } : null
  }

  async function getUser(req) {
    const context = await getSessionContext(req)
    return context?.user || null
  }

  // Persistent session inventory and user-scoped revocation.
  fastify.get('/v1/user/sessions', limit(30), async (req, reply) => {
    try {
      const context = await getSessionContext(req)
      if (!context) return reply.code(401).send({ error: 'Unauthorized' })
      const rows = await db('userSessions').where({ userId: context.user.id })
        .whereNull('revokedAt').orderBy('lastSeenAt', 'desc')
      return { success: true, sessions: rows.map(session => ({
        id: session.id, deviceName: session.deviceName, userAgent: session.userAgent,
        ipAddress: session.ipAddress, createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt, current: session.id === context.session.id,
      })) }
    } catch (err) {
      console.error('[sessions] failed to list sessions', err)
      return reply.code(500).send({ error: 'Could not load sessions.' })
    }
  })

  fastify.delete('/v1/user/sessions/:sessionId', limit(20), async (req, reply) => {
    try {
      const context = await getSessionContext(req)
      if (!context) return reply.code(401).send({ error: 'Unauthorized' })
      if (req.params.sessionId === context.session.id) {
        return reply.code(400).send({ error: 'The current session cannot revoke itself.' })
      }
      const changed = await db('userSessions')
        .where({ id: req.params.sessionId, userId: context.user.id })
        .whereNull('revokedAt').update({ revokedAt: new Date().toISOString() })
      if (!changed) return reply.code(404).send({ error: 'Session not found.' })
      world.network.revokeSession?.(req.params.sessionId)
      return { success: true, revoked: true }
    } catch (err) {
      console.error('[sessions] failed to revoke session', err)
      return reply.code(500).send({ error: 'Could not revoke session.' })
    }
  })

  const billingStatus = user => getBillingStatus(user, { enabled: billingEnabled })

  function sendError(reply, err) {
    if (err instanceof BillingError) return reply.code(err.statusCode).send({ error: err.message })
    console.error('[billing]', err)
    return reply.code(500).send({ error: 'Something went wrong. Please try again.' })
  }

  // Storyline & lore narrative
  fastify.get('/api/storyline', limit(100), async () => {
    return { success: true, storyline: STORYLINE }
  })

  // Billing status
  fastify.get('/api/billing/status', limit(60), async req => {
    const user = await getUser(req)
    return {
      success: true,
      enabled: billingEnabled,
      authenticated: !!user,
      plans: PUBLIC_PLANS,
      ...(user ? { billing: billingStatus(user) } : {}),
    }
  })

  // Read-only account billing profile for the unified settings dashboard.
  // All records are resolved from the bearer-authenticated user in this world.
  // World passes, toolkit licenses, cross-world ownership, and invoice history are
  // deliberately marked unavailable until authoritative data sources are implemented.
  fastify.get('/api/user/billing-profile', limit(30), async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) return reply.code(401).send({ success: false, error: 'Unauthorized' })

    try {
      const user = await getUser(req)
      if (!user) return reply.code(401).send({ success: false, error: 'Unauthorized' })

      const status = billingStatus(user)
      const currentPeriodEnd = user.currentPeriodEnd
        ? new Date(user.currentPeriodEnd).toISOString()
        : null
      const hasSubscriptionRecord = Boolean(user.stripeSubscriptionId || user.subscriptionPlan)

      return {
        success: true,
        profile: {
          userId: user.id,
          displayName: user.name || null,
          email: null,
          emailAvailability: 'not_supported',
        },
        billing: {
          ...status,
          currentPeriodEnd,
        },
        worldAccess: {
          status: 'current_world_only',
          scope: 'current_world',
          canExplore: status.canExplore,
          canBuildAndHost: status.canBuildAndHost,
          source: 'current_world_user_billing_record',
        },
        toolkitLicenses: {
          status: 'not_configured',
          items: [],
        },
        crossWorldAccess: {
          status: 'not_configured',
          items: [],
        },
        subscriptions: {
          status: hasSubscriptionRecord ? 'current_subscription_recorded' : 'no_subscription_record',
          current: hasSubscriptionRecord
            ? {
                plan: user.subscriptionPlan || null,
                status: user.subscriptionStatus || 'inactive',
                currentPeriodEnd,
              }
            : null,
        },
        history: {
          status: 'not_available',
          items: [],
        },
      }
    } catch (err) {
      console.error('[billing-profile] failed to load authenticated profile', err)
      return reply.code(500).send({ success: false, error: 'Could not load billing profile.' })
    }
  })

  // Start 14-day trial (only when billing is enabled)
  fastify.post('/api/billing/start-trial', limit(30), async (req, reply) => {
    if (!billingEnabled) return reply.code(409).send({ error: 'Trials are not active on this world.' })
    const user = await getUser(req)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    if (user.trialStartedAt) {
      return reply.code(400).send({ error: 'Trial already activated', billing: billingStatus(user) })
    }
    const trial = startUserTrial(user)
    await db('users').where('id', user.id).update(trial)
    Object.assign(user, trial)
    world.network.onUserBillingUpdated?.(user)
    return { success: true, billing: billingStatus(user) }
  })

  // Create a Stripe Checkout session for Architect Pro
  fastify.post('/api/billing/checkout', limit(20), async (req, reply) => {
    const user = await getUser(req)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    try {
      return { success: true, ...(await billing.createCheckout(user)) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  // Open the Stripe billing portal (manage / cancel)
  fastify.post('/api/billing/portal', limit(20), async (req, reply) => {
    const user = await getUser(req)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    try {
      return { success: true, ...(await billing.createPortal(user)) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  // Old endpoint granted Pro without payment. Pro is now only granted by verified Stripe webhooks.
  fastify.post('/api/billing/upgrade', limit(20), async (req, reply) => {
    return reply.code(410).send({ error: 'Use POST /api/billing/checkout to subscribe.' })
  })

  // Stripe webhook: needs the raw body for signature verification, so it lives in its own
  // encapsulated context with a buffer JSON parser.
  await fastify.register(async instance => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      done(null, body)
    })
    instance.post('/api/billing/webhook', limit(300), async (req, reply) => {
      try {
        return await billing.handleWebhook(req.body, req.headers['stripe-signature'])
      } catch (err) {
        return sendError(reply, err)
      }
    })
  })

  // Progression status
  fastify.get('/api/progression', limit(60), async req => {
    const user = await getUser(req)
    return {
      success: true,
      authenticated: !!user,
      progression: getProgressionStatus(user || {}),
      cosmetics: COSMETIC_ITEMS,
      missions: MISSIONS,
    }
  })

  // Claim a completed mission
  fastify.post('/api/progression/claim', limit(30), async (req, reply) => {
    const user = await getUser(req)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const result = claimMission(user, req.body?.missionId)
    if (!result.success) return reply.code(result.code).send({ error: result.reason })
    Object.assign(user, result.updates)
    await world.network.persistProgression(user)
    world.network.onUserProgressionUpdated?.(user.id)
    return { success: true, progression: getProgressionStatus(user), claimedMission: result.mission }
  })

  // Equip an unlocked cosmetic (skins only for now)
  fastify.post('/api/progression/equip', limit(30), async (req, reply) => {
    const user = await getUser(req)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })
    const result = equipCosmetic(user, req.body?.cosmeticId)
    if (!result.success) return reply.code(result.code).send({ error: result.reason })
    await world.network.applyEquip(user, result)
    return { success: true, equipped: result.item, avatar: user.avatar, progression: getProgressionStatus(user) }
  })
}
