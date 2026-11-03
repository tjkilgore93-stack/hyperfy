import crypto from 'crypto'
import { createJWT, readJWT } from '../core/utils-server.js'

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function issueSessionToken(db, userId, metadata = {}) {
  const sessionId = crypto.randomUUID()
  const token = await createJWT({ userId, sessionId })
  const now = new Date().toISOString()
  await db('userSessions').insert({
    id: sessionId,
    userId,
    tokenHash: hashSessionToken(token),
    deviceName: metadata.deviceName || null,
    userAgent: metadata.userAgent || null,
    ipAddress: metadata.ipAddress || null,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  })
  return { token, sessionId }
}

export async function getValidSession(db, token) {
  const payload = await readJWT(token)
  if (!payload?.userId || !payload?.sessionId) return null
  const session = await db('userSessions')
    .where({
      id: payload.sessionId,
      userId: payload.userId,
      tokenHash: hashSessionToken(token),
    })
    .whereNull('revokedAt')
    .first()
  if (!session) return null
  return { payload, session }
}

export async function touchSession(db, sessionId) {
  await db('userSessions').where({ id: sessionId }).whereNull('revokedAt').update({
    lastSeenAt: new Date().toISOString(),
  })
}
