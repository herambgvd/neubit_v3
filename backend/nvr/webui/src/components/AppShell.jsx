import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.jsx'
import { estate } from '../lib/api.js'

// Left-nav items in operator order: overview → device config → operations → admin.
const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: GridIcon },
  { to: '/channels', label: 'Channels', icon: CameraIcon },
  { to: '/recording', label: 'Recording', icon: RecordIcon },
  { to: '/storage', label: 'Storage', icon: DiskIcon },
  { to: '/live', label: 'Live', icon: PlayIcon },
  { to: '/playback', label: 'Playback', icon: RewindIcon },
  { to: '/users', label: 'Users', icon: UsersIcon },
  { to: '/logs', label: 'Logs', icon: ListIcon },
]

// AppShell is the authenticated frame: fixed left nav + top bar (node name +
// logout) + a scrollable content region the routed page renders into. The shell is
// `fixed inset-0` so the layout height is viewport-anchored regardless of the
// document's height cascade.
export default function AppShell() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [nodeName, setNodeName] = useState('NVR Node')

  // Fetch the node's display name for the top bar (best-effort — a failure leaves
  // the default label and never blocks the shell).
  useEffect(() => {
    let alive = true
    estate
      .get('/node')
      .then((n) => {
        if (alive && n && n.name) setNodeName(n.name)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <div className="fixed inset-0 flex bg-base text-gray-200">
      {/* Left navigation */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          <span className="text-sm font-semibold tracking-wide text-gray-100">
            NVR Console
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-elevated text-white'
                    : 'text-muted hover:bg-elevated hover:text-gray-200'
                }`
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3 text-xs text-faint">
          node-authoritative · offline-capable
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-5">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-100">{nodeName}</span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-faint">
              recorder
            </span>
          </div>
          <div className="flex items-center gap-4">
            {user?.username && (
              <span className="text-sm text-muted">
                {user.username}
                {user.role ? (
                  <span className="ml-1 text-faint">· {user.role}</span>
                ) : null}
              </span>
            )}
            <button className="btn-ghost" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

/* ── Minimal inline icons (stroke, currentColor) — no icon dependency ─────────── */
function svg(children) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}
function GridIcon() {
  return svg(
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </>,
  )
}
function CameraIcon() {
  return svg(
    <>
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </>,
  )
}
function RecordIcon() {
  return svg(<circle cx="12" cy="12" r="7" />)
}
function DiskIcon() {
  return svg(
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </>,
  )
}
function PlayIcon() {
  return svg(<polygon points="5 3 19 12 5 21 5 3" />)
}
function RewindIcon() {
  return svg(
    <>
      <polygon points="11 19 2 12 11 5 11 19" />
      <polygon points="22 19 13 12 22 5 22 19" />
    </>,
  )
}
function UsersIcon() {
  return svg(
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    </>,
  )
}
function ListIcon() {
  return svg(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>,
  )
}
