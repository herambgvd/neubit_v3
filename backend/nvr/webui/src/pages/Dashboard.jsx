import { useCallback, useEffect, useRef, useState } from 'react'
import { estate } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'

// Dashboard is the node console overview. It polls the node's own /estate/node and
// /estate/health every ~10s and renders node identity, engine (recording/streaming/
// nats/db) status, storage-usage bars, and per-array RAID health cards. All data is
// node-authoritative (same origin) so the page keeps working with central offline.
const REFRESH_MS = 10_000

export default function Dashboard() {
  const { user } = useAuth()
  const [node, setNode] = useState(null)
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(null)
  const timer = useRef(null)

  // load fetches node + health together. Failures surface a banner but keep the
  // last good data on screen so a transient blip doesn't blank the dashboard.
  const load = useCallback(async () => {
    try {
      const [n, h] = await Promise.all([
        estate.get('/node').catch(() => null),
        estate.get('/health'),
      ])
      if (n) setNode(n)
      setHealth(h)
      setError('')
      setUpdatedAt(new Date())
    } catch (e) {
      setError(e?.message || 'failed to load node health')
    } finally {
      setLoading(false)
    }
  }, [])

  // Poll on mount + every REFRESH_MS. The interval is cleared on unmount.
  useEffect(() => {
    load()
    timer.current = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer.current)
  }, [load])

  const storage = health && !health.storage?.error ? health.storage : null
  const storageErr = health?.storage?.error
  const rawRaid = health?.raid
  const raidArrays = Array.isArray(rawRaid) ? rawRaid : []
  const raidErr = !Array.isArray(rawRaid) ? rawRaid?.error : null

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Node health, engine state, storage, and RAID — served locally by this
            recorder.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-faint">
          {updatedAt && (
            <span>
              updated {updatedAt.toLocaleTimeString([], { hour12: false })}
            </span>
          )}
          <button className="btn-ghost" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-2.5 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !health ? (
        <div className="mt-6 card flex items-center justify-center p-12 text-sm text-faint">
          Loading node health…
        </div>
      ) : (
        <>
          {/* Node identity + engine status */}
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <NodeIdentityCard node={node} operator={user} />
            <div className="lg:col-span-2">
              <EngineCard health={health} />
            </div>
          </div>

          {/* Storage */}
          <SectionTitle>Storage</SectionTitle>
          {storage ? (
            <StorageCard storage={storage} />
          ) : (
            <div className="card p-5 text-sm text-muted">
              {storageErr
                ? `Storage probe unavailable — ${storageErr}`
                : 'No storage usage reported.'}
            </div>
          )}

          {/* RAID */}
          <SectionTitle>RAID arrays</SectionTitle>
          {raidErr ? (
            <div className="card p-5 text-sm text-muted">
              RAID probe unavailable — {raidErr}
            </div>
          ) : raidArrays.length === 0 ? (
            <div className="card p-5 text-sm text-faint">
              No software RAID arrays on this node.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {raidArrays.map((a) => (
                <RaidCard key={a.device} array={a} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ── Node identity ────────────────────────────────────────────────────────────── */
function NodeIdentityCard({ node, operator }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-100">Node</h2>
        <EnrollBadge state={node?.enroll_state} />
      </div>
      <div className="mt-4 space-y-3">
        <Field label="Name" value={node?.name || '—'} />
        <Field label="Node ID" value={node?.id} mono />
        <Field label="Tenant" value={node?.tenant_id} mono />
        <Field label="Central" value={node?.central_base_url || 'not linked'} />
        <Field label="Last sync" value={fmtTime(node?.last_sync_at)} />
        {operator?.username && (
          <Field label="Operator" value={operator.username} />
        )}
      </div>
    </div>
  )
}

function EnrollBadge({ state }) {
  const s = (state || 'unknown').toLowerCase()
  const tone =
    s === 'enrolled'
      ? 'border-ok/40 bg-ok/10 text-ok'
      : s === 'pending'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-border bg-elevated text-faint'
  return (
    <span
      className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}
    >
      {state || 'unknown'}
    </span>
  )
}

/* ── Engine status ────────────────────────────────────────────────────────────── */
function EngineCard({ health }) {
  const items = [
    { label: 'Recording', ok: !!health?.recording },
    { label: 'Streaming', ok: !!health?.streaming },
    { label: 'Database', ok: !!health?.db_ok },
    { label: 'NATS', ok: health?.nats, optional: true },
  ]
  return (
    <div className="card h-full p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-100">Engine</h2>
        {health?.store && (
          <span className="text-xs text-faint">store · {health.store}</span>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((it) => (
          <StatusTile key={it.label} {...it} />
        ))}
      </div>
    </div>
  )
}

function StatusTile({ label, ok, optional }) {
  // `nats` is optional: `undefined` (not reported) renders as neutral "n/a".
  const neutral = optional && ok == null
  const dot = neutral ? 'bg-faint' : ok ? 'bg-ok' : 'bg-danger'
  const text = neutral ? 'n/a' : ok ? 'up' : 'down'
  const textTone = neutral ? 'text-faint' : ok ? 'text-ok' : 'text-danger'
  return (
    <div className="rounded-md border border-border bg-elevated px-3 py-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${dot} ${!neutral && ok ? 'shadow-[0_0_6px] shadow-ok/60' : ''}`}
        />
        <span className="text-xs text-muted">{label}</span>
      </div>
      <div className={`mt-1.5 text-sm font-medium capitalize ${textTone}`}>
        {text}
      </div>
    </div>
  )
}

/* ── Storage ──────────────────────────────────────────────────────────────────── */
function StorageCard({ storage }) {
  const pct = clampPct(storage.used_percent)
  const tone = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-gray-100">Recordings volume</h2>
          <span className="font-mono text-xs text-faint">{storage.path}</span>
        </div>
        <span className="text-sm font-medium text-gray-100">
          {pct.toFixed(1)}%
        </span>
      </div>

      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-elevated">
        <div
          className={`h-full rounded-full ${tone} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <Metric label="Used" value={fmtBytes(storage.used_bytes)} />
        <Metric label="Free" value={fmtBytes(storage.free_bytes)} />
        <Metric label="Total" value={fmtBytes(storage.total_bytes)} />
      </div>
    </div>
  )
}

/* ── RAID ─────────────────────────────────────────────────────────────────────── */
function RaidCard({ array }) {
  const health = (array.health || 'unknown').toLowerCase()
  const tone = raidTone(health)
  const rebuilding = health === 'rebuilding' && array.rebuild_percent != null
  return (
    <div className={`card p-5 ${tone.ring}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-sm text-gray-100">{array.device}</div>
          <div className="text-xs uppercase tracking-wide text-faint">
            {array.level}
          </div>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone.badge}`}
        >
          {array.health}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Metric label="Working" value={numOrDash(array.working_devices)} />
        <Metric
          label="Failed"
          value={numOrDash(array.failed_devices)}
          danger={array.failed_devices > 0}
        />
        <Metric label="Total" value={numOrDash(array.total_devices)} />
      </div>

      {rebuilding && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="capitalize text-muted">
              {array.rebuild_status || 'rebuild'}
            </span>
            <span className="text-gray-100">{array.rebuild_percent}%</span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-warn transition-all"
              style={{ width: `${clampPct(array.rebuild_percent)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function raidTone(health) {
  switch (health) {
    case 'healthy':
      return { badge: 'border-ok/40 bg-ok/10 text-ok', ring: '' }
    case 'rebuilding':
      return {
        badge: 'border-warn/40 bg-warn/10 text-warn',
        ring: 'ring-1 ring-warn/30',
      }
    case 'degraded':
      return {
        badge: 'border-warn/40 bg-warn/10 text-warn',
        ring: 'ring-1 ring-warn/40',
      }
    case 'failed':
      return {
        badge: 'border-danger/40 bg-danger/10 text-danger',
        ring: 'ring-1 ring-danger/50',
      }
    default:
      return { badge: 'border-border bg-elevated text-faint', ring: '' }
  }
}

/* ── Small shared bits ────────────────────────────────────────────────────────── */
function SectionTitle({ children }) {
  return (
    <h2 className="mb-3 mt-8 text-xs font-semibold uppercase tracking-wider text-faint">
      {children}
    </h2>
  )
}

function Field({ label, value, mono }) {
  const display = value == null || value === '' ? '—' : String(value)
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-faint">{label}</span>
      <span
        className={`truncate text-right text-sm text-gray-200 ${mono ? 'font-mono text-xs' : ''}`}
        title={display}
      >
        {display}
      </span>
    </div>
  )
}

function Metric({ label, value, danger }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div
        className={`mt-0.5 text-sm font-medium ${danger ? 'text-danger' : 'text-gray-100'}`}
      >
        {value}
      </div>
    </div>
  )
}

/* ── Formatters ───────────────────────────────────────────────────────────────── */
function fmtBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  let v = Number(n)
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtTime(iso) {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { hour12: false })
}

function clampPct(n) {
  const v = Number(n)
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function numOrDash(n) {
  return n == null ? '—' : String(n)
}
