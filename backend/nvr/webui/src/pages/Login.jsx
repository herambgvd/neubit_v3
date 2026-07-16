import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'

// Login is the standalone-console sign-in: username/password against the node's own
// /estate/auth/login. On success it redirects to the originally-requested page (or
// /dashboard). An already-authenticated visitor skips the form entirely.
export default function Login() {
  const { isAuthenticated, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/dashboard'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  if (isAuthenticated) {
    return <Navigate to={from} replace />
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await login(username.trim(), password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err?.message || 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-base px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
          </div>
          <h1 className="text-lg font-semibold tracking-wide text-gray-100">
            NVR Node Console
          </h1>
          <p className="mt-1 text-sm text-muted">
            Sign in to the recorder appliance
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 p-6">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Username
            </label>
            <input
              className="input"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted">
              Password
            </label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={busy || !username.trim() || !password}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-faint">
          This console talks only to this recorder — it works with the central
          system offline.
        </p>
      </div>
    </div>
  )
}
