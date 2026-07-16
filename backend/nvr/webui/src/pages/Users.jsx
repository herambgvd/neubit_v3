import { useCallback, useEffect, useMemo, useState } from 'react'
import { estate } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'

// Users is the local-operator admin page for the standalone box console. It manages
// the node's own accounts (GET/POST/PATCH/DELETE /estate/local-users) — the local
// root of trust the appliance authenticates against when the central control plane
// is offline. Every mutating action is admin-only; a non-admin sees a read-only
// list with the write controls withheld (the API also enforces this, so the guard
// is purely UX).

const ROLES = ['admin', 'operator', 'viewer']

const ROLE_BADGE = {
  admin: 'border-accent/40 bg-accent/10 text-accent',
  operator: 'border-warn/40 bg-warn/10 text-warn',
  viewer: 'border-border bg-elevated text-muted',
}

export default function Users() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Modal state: `null` = closed; otherwise { mode: 'create'|'reset', user? }.
  const [modal, setModal] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await estate.get('/local-users')
      setUsers(res?.items || [])
    } catch (e) {
      setError(e.message || 'failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // flash surfaces a transient success line under the header, auto-clearing so it
  // never lingers as stale state.
  const flash = useCallback((msg) => {
    setNotice(msg)
    window.setTimeout(() => setNotice(''), 3500)
  }, [])

  const sorted = useMemo(
    () =>
      [...users].sort((a, b) => a.username.localeCompare(b.username)),
    [users],
  )

  // ── mutations ────────────────────────────────────────────────────────────────

  async function toggleActive(u) {
    setError('')
    try {
      const updated = await estate.patch(`/local-users/${u.id}`, {
        is_active: !u.is_active,
      })
      setUsers((list) => list.map((x) => (x.id === updated.id ? updated : x)))
      flash(`${u.username} ${updated.is_active ? 'enabled' : 'disabled'}`)
    } catch (e) {
      setError(e.message || 'failed to update user')
    }
  }

  async function removeUser(u) {
    if (!window.confirm(`Delete local user "${u.username}"? This cannot be undone.`)) {
      return
    }
    setError('')
    try {
      await estate.del(`/local-users/${u.id}`)
      setUsers((list) => list.filter((x) => x.id !== u.id))
      flash(`${u.username} deleted`)
    } catch (e) {
      setError(e.message || 'failed to delete user')
    }
  }

  function onCreated(created) {
    setUsers((list) => [...list, created])
    flash(`${created.username} created`)
    setModal(null)
  }

  function onReset(u) {
    flash(`Password reset for ${u.username}`)
    setModal(null)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Local users</h1>
          <p className="mt-1 text-sm text-muted">
            Operator accounts stored on this recorder. Used to sign in when the
            central platform is unreachable.
          </p>
        </div>
        {isAdmin && (
          <button
            className="btn-primary shrink-0"
            onClick={() => setModal({ mode: 'create' })}
          >
            Add user
          </button>
        )}
      </div>

      {notice && (
        <div className="mb-4 rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {!isAdmin && (
        <div className="mb-4 rounded-md border border-border bg-elevated px-3 py-2 text-sm text-muted">
          You are signed in as{' '}
          <span className="text-gray-200">{user?.role || 'a non-admin'}</span>.
          Managing users requires the <span className="text-gray-200">admin</span>{' '}
          role — this list is read-only.
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-faint">
              <th className="px-4 py-3 font-medium">User</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last login</th>
              {isAdmin && (
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={isAdmin ? 5 : 4}>
                  Loading…
                </td>
              </tr>
            ) : sorted.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted" colSpan={isAdmin ? 5 : 4}>
                  No local users.
                </td>
              </tr>
            ) : (
              sorted.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  isAdmin={isAdmin}
                  isSelf={u.id === user?.id}
                  onToggle={() => toggleActive(u)}
                  onReset={() => setModal({ mode: 'reset', user: u })}
                  onDelete={() => removeUser(u)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {modal?.mode === 'create' && (
        <CreateUserModal onClose={() => setModal(null)} onCreated={onCreated} />
      )}
      {modal?.mode === 'reset' && (
        <ResetPasswordModal
          user={modal.user}
          onClose={() => setModal(null)}
          onReset={onReset}
        />
      )}
    </div>
  )
}

// UserRow renders one account line. Admin write controls are inline on the right;
// the bootstrap admin cannot be disabled or deleted (the API rejects it too — we
// disable the buttons so the operator isn't led into a guaranteed error).
function UserRow({ user, isAdmin, isSelf, onToggle, onReset, onDelete }) {
  const locked =
    user.locked_until && new Date(user.locked_until) > new Date()
  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-elevated/40">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-100">{user.username}</span>
          {user.is_bootstrap && (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">
              bootstrap
            </span>
          )}
          {isSelf && (
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">
              you
            </span>
          )}
        </div>
        {user.full_name && (
          <div className="mt-0.5 text-xs text-faint">{user.full_name}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-block rounded border px-2 py-0.5 text-xs capitalize ${
            ROLE_BADGE[user.role] || ROLE_BADGE.viewer
          }`}
        >
          {user.role}
        </span>
      </td>
      <td className="px-4 py-3">
        {locked ? (
          <StatusDot color="warn" label="Locked" />
        ) : user.is_active ? (
          <StatusDot color="ok" label="Active" />
        ) : (
          <StatusDot color="faint" label="Disabled" />
        )}
        {user.must_change_password && (
          <div className="mt-0.5 text-[11px] text-warn">must change password</div>
        )}
      </td>
      <td className="px-4 py-3 text-muted">{formatTime(user.last_login_at)}</td>
      {isAdmin && (
        <td className="px-4 py-3">
          <div className="flex items-center justify-end gap-1.5">
            <button
              className="btn-ghost px-2 py-1 text-xs"
              onClick={onToggle}
              disabled={user.is_bootstrap}
              title={
                user.is_bootstrap
                  ? 'The bootstrap admin cannot be disabled'
                  : user.is_active
                    ? 'Disable account'
                    : 'Enable account'
              }
            >
              {user.is_active ? 'Disable' : 'Enable'}
            </button>
            <button
              className="btn-ghost px-2 py-1 text-xs"
              onClick={onReset}
              title="Reset password"
            >
              Reset password
            </button>
            <button
              className="btn-ghost px-2 py-1 text-xs text-danger hover:bg-danger/10"
              onClick={onDelete}
              disabled={user.is_bootstrap}
              title={
                user.is_bootstrap
                  ? 'The bootstrap admin cannot be deleted'
                  : 'Delete account'
              }
            >
              Delete
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}

function StatusDot({ color, label }) {
  const dot = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    faint: 'bg-faint',
  }[color]
  return (
    <span className="inline-flex items-center gap-2 text-gray-200">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  )
}

// ── Create user ────────────────────────────────────────────────────────────────

function CreateUserModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    username: '',
    full_name: '',
    password: '',
    role: 'viewer',
    must_change_password: false,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value
    setForm((f) => ({ ...f, [k]: v }))
  }

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (!form.username.trim()) return setErr('Username is required.')
    if (!form.password) return setErr('Password is required.')
    setBusy(true)
    try {
      const created = await estate.post('/local-users', {
        username: form.username.trim(),
        password: form.password,
        full_name: form.full_name.trim() || null,
        role: form.role,
        must_change_password: form.must_change_password,
      })
      onCreated(created)
    } catch (e2) {
      setErr(e2.message || 'failed to create user')
      setBusy(false)
    }
  }

  return (
    <Modal title="Add local user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username">
          <input
            className="input"
            value={form.username}
            onChange={set('username')}
            autoFocus
            autoComplete="off"
            placeholder="e.g. control-room-2"
          />
        </Field>
        <Field label="Full name" hint="optional">
          <input
            className="input"
            value={form.full_name}
            onChange={set('full_name')}
            autoComplete="off"
          />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Role">
          <select className="input" value={form.role} onChange={set('role')}>
            {ROLES.map((r) => (
              <option key={r} value={r} className="bg-surface capitalize">
                {r}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={form.must_change_password}
            onChange={set('must_change_password')}
          />
          Require password change at first sign-in
        </label>

        {err && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {err}
          </div>
        )}
        <ModalActions busy={busy} submitLabel="Create user" onClose={onClose} />
      </form>
    </Modal>
  )
}

// ── Reset password ─────────────────────────────────────────────────────────────

function ResetPasswordModal({ user, onClose, onReset }) {
  const [password, setPassword] = useState('')
  const [mustChange, setMustChange] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setErr('')
    if (!password) return setErr('Password is required.')
    setBusy(true)
    try {
      await estate.patch(`/local-users/${user.id}`, {
        password,
        must_change_password: mustChange,
      })
      onReset(user)
    } catch (e2) {
      setErr(e2.message || 'failed to reset password')
      setBusy(false)
    }
  }

  return (
    <Modal title={`Reset password — ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="New password">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="new-password"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            className="h-4 w-4 accent-accent"
            checked={mustChange}
            onChange={(e) => setMustChange(e.target.checked)}
          />
          Require password change at next sign-in
        </label>

        {err && (
          <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {err}
          </div>
        )}
        <ModalActions busy={busy} submitLabel="Reset password" onClose={onClose} />
      </form>
    </Modal>
  )
}

// ── shared modal primitives ────────────────────────────────────────────────────

function Modal({ title, onClose, children }) {
  // Close on Escape for keyboard operators at the control desk.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="card w-full max-w-md p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-100">{title}</h2>
          <button
            className="text-faint hover:text-gray-200"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ModalActions({ busy, submitLabel, onClose }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-faint">
        {label}
        {hint && <span className="normal-case tracking-normal">· {hint}</span>}
      </span>
      {children}
    </label>
  )
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
