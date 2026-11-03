import { css } from '@firebolt-dev/css'
import { useCallback, useEffect, useState } from 'react'
import { AlertCircleIcon, CheckCircle2Icon, Clock3Icon, LaptopIcon, LoaderIcon, MonitorIcon, RefreshCwIcon, ShieldCheckIcon, SmartphoneIcon, Trash2Icon } from 'lucide-react'
import { storage } from '../../core/storage'

function formatDate(value) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString()
}

function sessionDevice(session) {
  if (session.deviceName || session.device) return session.deviceName || session.device
  const agent = session.userAgent || ''
  if (/iphone|ipad|ipod/i.test(agent)) return 'Apple mobile device'
  if (/android/i.test(agent)) return 'Android device'
  if (/macintosh|mac os/i.test(agent)) return 'Mac'
  if (/windows/i.test(agent)) return 'Windows PC'
  if (/linux/i.test(agent)) return 'Linux device'
  return 'Browser session'
}

function isMobileSession(session) {
  return /iphone|ipad|ipod|android|mobile/i.test(
    [session.deviceName, session.device, session.userAgent].filter(Boolean).join(' ')
  )
}

/**
 * Account and session controls for Hyperfy's existing in-world Sidebar.
 *
 * Display-name updates use the existing Player.setName network path.
 * Session inventory/revocation use the versioned API contract; the panel
 * reads and revokes persistent sessions through the versioned server API.
 */
export function SettingsAccount({ world, hidden }) {
  const player = world.entities.player
  const [name, setName] = useState(player?.data?.name || '')
  const [savingName, setSavingName] = useState(false)
  const [nameMessage, setNameMessage] = useState('')
  const [sessions, setSessions] = useState([])
  const [sessionState, setSessionState] = useState('loading')
  const [sessionError, setSessionError] = useState('')
  const [revokingId, setRevokingId] = useState(null)

  const accountId = player?.data?.userId || player?.data?.id || 'Unavailable'
  const authToken = storage.get('authToken')
  const apiBase = (world.network.apiUrl || '').replace(/\/$/, '')

  const loadSessions = useCallback(async signal => {
    if (!apiBase || !authToken) {
      setSessionState('unavailable')
      setSessionError('A signed-in session and API URL are required to load session records.')
      return
    }

    setSessionState('loading')
    setSessionError('')
    try {
      const response = await fetch(`${apiBase}/v1/user/sessions`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
        cache: 'no-store',
        signal,
      })

      if (response.status === 404 || response.status === 501) {
        setSessions([])
        setSessionState('unavailable')
        setSessionError('Server-side session inventory is not enabled for this world yet.')
        return
      }

      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Could not load sessions (${response.status}).`)
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
      setSessionState('ready')
    } catch (error) {
      if (error?.name === 'AbortError') return
      setSessionState('error')
      setSessionError(error?.message || 'Could not load active sessions.')
    }
  }, [apiBase, authToken])

  useEffect(() => {
    const controller = new AbortController()
    loadSessions(controller.signal)
    return () => controller.abort()
  }, [loadSessions])

  const saveName = () => {
    const nextName = name.trim()
    if (!nextName || nextName.length > 32) {
      setNameMessage('Use a name between 1 and 32 characters.')
      return
    }
    if (nextName === player?.data?.name) {
      setNameMessage('Your display name is already up to date.')
      return
    }
    setSavingName(true)
    setNameMessage('')
    try {
      // This is the repository's existing profile update path. The server persists
      // the player name through ServerNetwork.onEntityModified.
      player.setName(nextName)
      setName(nextName)
      setNameMessage('Display name update submitted.')
    } catch (error) {
      setNameMessage(error?.message || 'Could not update your display name.')
    } finally {
      setSavingName(false)
    }
  }

  const revokeSession = async session => {
    if (!apiBase || !authToken || !session.id) return
    setRevokingId(session.id)
    setSessionError('')
    try {
      const response = await fetch(
        `${apiBase}/v1/user/sessions/${encodeURIComponent(session.id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${authToken}` },
          cache: 'no-store',
        }
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Could not revoke session (${response.status}).`)
      await loadSessions()
    } catch (error) {
      setSessionError(error?.message || 'Could not revoke this session.')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <Pane hidden={hidden}>
      <div
        className='settings-account noscrollbar'
        css={css`
          overflow-y: auto;
          background: rgba(11, 10, 21, 0.9);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 1.375rem;
          padding: 0.85rem 0;
          color: rgba(255, 255, 255, 0.92);
          .account-heading {
            padding: 0.25rem 1rem 0.8rem;
          }
          .account-title {
            margin: 0;
            font-size: 1rem;
            font-weight: 650;
          }
          .account-subtitle {
            margin: 0.3rem 0 0;
            color: rgba(255, 255, 255, 0.52);
            font-size: 0.78rem;
            line-height: 1.4;
          }
          .account-section {
            border-top: 1px solid rgba(255, 255, 255, 0.07);
            padding: 0.9rem 1rem;
          }
          .account-section-title {
            display: flex;
            align-items: center;
            gap: 0.45rem;
            margin: 0 0 0.7rem;
            font-size: 0.83rem;
            font-weight: 650;
          }
          .account-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.8rem;
            min-width: 0;
            padding: 0.45rem 0;
          }
          .account-label {
            color: rgba(255, 255, 255, 0.54);
            font-size: 0.78rem;
          }
          .account-value {
            min-width: 0;
            overflow-wrap: anywhere;
            text-align: right;
            color: rgba(255, 255, 255, 0.9);
            font-size: 0.8rem;
          }
          .account-input {
            display: block;
            width: 100%;
            box-sizing: border-box;
            margin-top: 0.35rem;
            padding: 0.65rem 0.7rem;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 0.55rem;
            background: rgba(255, 255, 255, 0.05);
            color: white;
            outline: none;
            font: inherit;
            font-size: 0.85rem;
          }
          .account-input:focus {
            border-color: rgba(0, 229, 255, 0.65);
          }
          .account-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.4rem;
            min-height: 2.15rem;
            padding: 0.45rem 0.75rem;
            border: 1px solid rgba(0, 229, 255, 0.38);
            border-radius: 0.55rem;
            background: rgba(0, 229, 255, 0.12);
            color: #b9f6ff;
            font: inherit;
            font-size: 0.78rem;
            cursor: pointer;
          }
          .account-button:disabled {
            opacity: 0.45;
            cursor: not-allowed;
          }
          .account-button.danger {
            border-color: rgba(255, 86, 86, 0.35);
            background: rgba(255, 86, 86, 0.09);
            color: #ffaaaa;
          }
          .account-notice {
            display: flex;
            align-items: flex-start;
            gap: 0.5rem;
            padding: 0.65rem;
            border: 1px solid rgba(255, 190, 80, 0.2);
            border-radius: 0.6rem;
            background: rgba(255, 190, 80, 0.06);
            color: rgba(255, 226, 180, 0.9);
            font-size: 0.75rem;
            line-height: 1.45;
          }
          .account-session {
            padding: 0.75rem 0;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
          }
          .account-session:first-of-type {
            border-top: 0;
          }
          .account-session-top {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 0.65rem;
          }
          .account-session-device {
            display: flex;
            gap: 0.55rem;
            min-width: 0;
          }
          .account-session-name {
            font-size: 0.8rem;
            font-weight: 600;
          }
          .account-session-meta {
            margin-top: 0.25rem;
            color: rgba(255, 255, 255, 0.48);
            font-size: 0.7rem;
            line-height: 1.4;
            overflow-wrap: anywhere;
          }
          .account-current {
            display: inline-block;
            margin-left: 0.35rem;
            color: #8de8ce;
            font-size: 0.65rem;
            font-weight: 650;
          }
          .account-empty {
            padding: 0.7rem 0;
            color: rgba(255, 255, 255, 0.55);
            font-size: 0.78rem;
            line-height: 1.5;
          }
        `}
      >
        <div className='account-heading'>
          <h3 className='account-title'>Account</h3>
          <p className='account-subtitle'>Manage your Hyperfy profile and signed-in devices.</p>
        </div>

        <div className='account-section'>
          <div className='account-section-title'><ShieldCheckIcon size={15} /> Profile</div>
          <div className='account-row'>
            <span className='account-label'>Account ID</span>
            <span className='account-value'>{accountId}</span>
          </div>
          <label className='account-label' htmlFor='settings-account-name'>Display name</label>
          <input
            id='settings-account-name'
            className='account-input'
            value={name}
            maxLength={32}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') saveName()
            }}
            placeholder='Your display name'
          />
          <div className='account-row'>
            <span className='account-label'>{nameMessage}</span>
            <button className='account-button' onClick={saveName} disabled={savingName || !name.trim()}>
              {savingName ? <LoaderIcon size={13} /> : <CheckCircle2Icon size={13} />}
              Save name
            </button>
          </div>
          <div className='account-notice'>
            <AlertCircleIcon size={15} />
            <span>This world currently uses bearer-token identity and does not expose email/password credential management. Only the existing display-name update is available here.</span>
          </div>
        </div>

        <div className='account-section'>
          <div className='account-row'>
            <div className='account-section-title'><LaptopIcon size={15} /> Active sessions</div>
            <button
              className='account-button'
              onClick={() => loadSessions()}
              disabled={sessionState === 'loading'}
              aria-label='Refresh active sessions'
            >
              {sessionState === 'loading' ? <LoaderIcon size={13} /> : <RefreshCwIcon size={13} />}
              Refresh
            </button>
          </div>

          {sessionState === 'loading' && (
            <div className='account-empty'><LoaderIcon size={14} /> Loading session inventory…</div>
          )}
          {sessionState === 'unavailable' && (
            <div className='account-notice'>
              <AlertCircleIcon size={15} />
              <span>{sessionError} The server did not make session inventory available. No device list or revocation state is assumed.</span>
            </div>
          )}
          {sessionState === 'error' && (
            <div className='account-notice'>
              <AlertCircleIcon size={15} />
              <span>{sessionError}</span>
            </div>
          )}
          {sessionState === 'ready' && sessions.length === 0 && (
            <div className='account-empty'>No active session records were returned by the server.</div>
          )}
          {sessionState === 'ready' && sessions.map(session => {
            const current = !!(session.current || session.isCurrent)
            const mobile = isMobileSession(session)
            const DeviceIcon = mobile ? SmartphoneIcon : MonitorIcon
            return (
              <div className='account-session' key={session.id}>
                <div className='account-session-top'>
                  <div className='account-session-device'>
                    <DeviceIcon size={17} />
                    <div>
                      <div className='account-session-name'>
                        {sessionDevice(session)}
                        {current && <span className='account-current'>This device</span>}
                      </div>
                      <div className='account-session-meta'>
                        {session.userAgent || 'Browser details unavailable'}
                        {session.ipAddress || session.ip ? ` · ${session.ipAddress || session.ip}` : ''}
                      </div>
                      <div className='account-session-meta'>
                        <Clock3Icon size={11} /> Last active: {formatDate(session.lastSeenAt)}
                      </div>
                    </div>
                  </div>
                  <button
                    className='account-button danger'
                    onClick={() => revokeSession(session)}
                    disabled={current || revokingId === session.id}
                    title={current ? 'The current session cannot be revoked from itself.' : 'Revoke this session'}
                  >
                    {revokingId === session.id ? <LoaderIcon size={12} /> : <Trash2Icon size={12} />}
                    Revoke
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </Pane>
  )
}

function Pane({ hidden, children }) {
  return (
    <div
      className={`sidebarpane${hidden ? ' hidden' : ''}`}
      css={css`
        width: 20rem;
        max-width: 100%;
        display: flex;
        flex-direction: column;
        .sidebarpane-content {
          pointer-events: auto;
          max-height: 100%;
          display: flex;
          flex-direction: column;
        }
        &.hidden {
          opacity: 0;
          pointer-events: none;
        }
      `}
    >
      <div className='sidebarpane-content'>{children}</div>
    </div>
  )
}
