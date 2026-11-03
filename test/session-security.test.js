import test from 'node:test'
import assert from 'node:assert/strict'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'session-security-test-secret'

const [{ default: Fastify }, { default: Knex }, sessions, { registerMonetizationRoutes }] = await Promise.all([
  import('fastify'),
  import('knex'),
  import('../src/server/sessions.js'),
  import('../src/server/routes.js'),
])

async function setup() {
  const db = Knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  })

  await db.schema.createTable('users', table => {
    table.string('id').primary()
    table.string('name')
  })
  await db.schema.createTable('userSessions', table => {
    table.string('id').primary()
    table.string('userId').notNullable()
    table.string('tokenHash').notNullable().unique()
    table.string('deviceName').nullable()
    table.text('userAgent').nullable()
    table.string('ipAddress').nullable()
    table.timestamp('createdAt').notNullable()
    table.timestamp('lastSeenAt').notNullable()
    table.timestamp('revokedAt').nullable()
  })

  await db('users').insert([
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ])

  const revokedSockets = []
  const world = {
    network: {
      getLiveUser: () => null,
      revokeSession: sessionId => revokedSockets.push(sessionId),
    },
  }
  const app = Fastify()
  await registerMonetizationRoutes(app, { db, world })
  await app.ready()

  return {
    app,
    db,
    revokedSockets,
    close: async () => {
      await app.close()
      await db.destroy()
    },
  }
}

test('session tokens are stored as SHA-256 hashes and resolve to their owner', async () => {
  const { db, close } = await setup()
  try {
    const issued = await sessions.issueSessionToken(db, 'alice')
    const row = await db('userSessions').where({ id: issued.sessionId }).first()

    assert.ok(row)
    assert.equal(row.userId, 'alice')
    assert.equal(row.tokenHash, sessions.hashSessionToken(issued.token))
    assert.notEqual(row.tokenHash, issued.token)

    const valid = await sessions.getValidSession(db, issued.token)
    assert.equal(valid.payload.userId, 'alice')
    assert.equal(valid.session.id, issued.sessionId)
  } finally {
    await close()
  }
})

test('a user cannot revoke another user session or change its persisted state', async () => {
  const { app, db, revokedSockets, close } = await setup()
  try {
    const alice = await sessions.issueSessionToken(db, 'alice')
    const bob = await sessions.issueSessionToken(db, 'bob')

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/user/sessions/${bob.sessionId}`,
      headers: { authorization: `Bearer ${alice.token}` },
    })

    // 404 intentionally avoids disclosing whether another user's session ID exists.
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { error: 'Session not found.' })

    const bobRow = await db('userSessions').where({ id: bob.sessionId }).first()
    assert.equal(bobRow.revokedAt, null, 'Bob session must remain active')
    assert.ok(await sessions.getValidSession(db, bob.token), 'Bob token must remain valid')
    assert.deepEqual(revokedSockets, [], 'no socket may be closed for the untouched Bob session')
  } finally {
    await close()
  }
})

test('a user can revoke a different session belonging to that same user', async () => {
  const { app, db, revokedSockets, close } = await setup()
  try {
    const current = await sessions.issueSessionToken(db, 'alice')
    const other = await sessions.issueSessionToken(db, 'alice')

    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/user/sessions/${other.sessionId}`,
      headers: { authorization: `Bearer ${current.token}` },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { success: true, revoked: true })

    const row = await db('userSessions').where({ id: other.sessionId }).first()
    assert.ok(row.revokedAt)
    assert.equal(await sessions.getValidSession(db, other.token), null)
    assert.deepEqual(revokedSockets, [other.sessionId])
    assert.ok(await sessions.getValidSession(db, current.token), 'the requesting session remains valid')
  } finally {
    await close()
  }
})

test('a session cannot revoke itself and unauthenticated requests cannot revoke sessions', async () => {
  const { app, db, close } = await setup()
  try {
    const current = await sessions.issueSessionToken(db, 'alice')

    const selfRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/user/sessions/${current.sessionId}`,
      headers: { authorization: `Bearer ${current.token}` },
    })
    assert.equal(selfRevoke.statusCode, 400)

    const unauthenticated = await app.inject({
      method: 'DELETE',
      url: '/v1/user/sessions/any-session-id',
    })
    assert.equal(unauthenticated.statusCode, 401)

    const row = await db('userSessions').where({ id: current.sessionId }).first()
    assert.equal(row.revokedAt, null)
  } finally {
    await close()
  }
})

test('revoked and tampered bearer tokens cannot list or revoke sessions', async () => {
  const { app, db, close } = await setup()
  try {
    const current = await sessions.issueSessionToken(db, 'alice')
    const target = await sessions.issueSessionToken(db, 'alice')

    await db('userSessions').where({ id: current.sessionId }).update({ revokedAt: new Date().toISOString() })

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/user/sessions/${target.sessionId}`,
      headers: { authorization: `Bearer ${current.token}` },
    })
    assert.equal(revoked.statusCode, 401)

    const tamperedToken = `${target.token.slice(0, -1)}x`
    const tampered = await app.inject({
      method: 'DELETE',
      url: `/v1/user/sessions/${target.sessionId}`,
      headers: { authorization: `Bearer ${tamperedToken}` },
    })
    assert.equal(tampered.statusCode, 401)

    const row = await db('userSessions').where({ id: target.sessionId }).first()
    assert.equal(row.revokedAt, null)
  } finally {
    await close()
  }
})
