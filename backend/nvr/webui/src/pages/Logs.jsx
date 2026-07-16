import { useCallback, useEffect, useState } from 'react'
import { estate } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'

// Logs is the node's Diagnostics + audit screen. It reads the node's own
// /estate/node (identity + enrollment/sync) and /estate/health (DB / store /
// recording / streaming status + recordings-volume disk usage + RAID health) so
// an operator can eyeball the recorder appliance's condition with the central
// system offline.
//
// The node writes an append-only audit_log on every write, but the estate API
// does not (yet) expose a list-audit endpoint — so the audit section renders a
// note explaining where the trail lives rather than a fabricated list.
export default function Logs() {
  const { user } = useAuth()
  const [node, setNode] = useState(null)
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (initial) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    setError('')
    try {
      // /estate/node is 404 before first-boot bootstrap — tolerate it so a fresh
      // box still shows health rather than a hard error.
      const [nodeRes, healthRes] = await Promise.all([
        estate.get('/node').catch(() => null),
        estate.get('/health'),
      ])
      setNode(nodeRes)
      setHealth(healthRes)
    } catch (err) {
      setError(err?.message || 'Failed to load diagnostics')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(true)
  }, [load])

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Logs</h1>
          <p className="mt-1 text-sm text-muted">
            Diagnostics and audit — configuration and access events on this node.
          </p>
        </div>
        <button
          className="btn-ghost shrink-0"
          onClick={() => load(false)}
          disabled={loading || refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mt-6 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-6 card flex items-center justify-center p-12 text-sm text-faint">
          Loading diagnostics…
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <NodeCard node={node} />
          <DiagnosticsCard health={health} />
          <StorageCard storage={health?.storage} />
          <RaidCard raid={health?.raid} />
          <AuditCard user={user} />
        </div>
      )}
    </div>
  )
}

// NodeCard shows the recorder's identity + how in-sync it is with the central
// control plane. Absent before bootstrap.
function NodeCard({ node }) {
  return (
    <Section title="Node" subtitle="Identity and central-sync state">
      {node ? (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <Field label="Name" value={node.name} />
          <Field label="Node ID" value={node.id} mono />
          <Field label="Tenant" value={node.tenant_id || '—'} mono />
          <Field
            label="Enrollment"
            value={<EnrollBadge state={node.enroll_state} />}
          />
          <Field label="Enrolled" value={fmtTime(node.enrolled_at)} />
          <Field label="Last sync" value={fmtTime(node.last_sync_at)} />
          <Field
            label="Central"
            value={node.central_base_url || '—'}
            mono
          />
        </dl>
      ) : (
        <p className="text-sm text-faint">
          This recorder has not been bootstrapped yet — no node identity is
          registered.
        </p>
      )}
    </Section>
  )
}

// DiagnosticsCard is the at-a-glance subsystem status from /estate/health.
function DiagnosticsCard({ health }) {
  const items = [
    { label: 'Database', ok: health?.db_ok },
    { label: 'Recording engine', ok: health?.recording },
    { label: 'Streaming engine', ok: health?.streaming },
  ]
  return (
    <Section title="Diagnostics" subtitle="Local subsystem health">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <StatusTile key={it.label} label={it.label} ok={it.ok} />
        ))}
        <div className="flex items-center justify-between rounded-md border border-border bg-elevated px-3 py-2.5">
          <span className="text-sm text-gray-300">Store</span>
          <span className="font-mono text-xs uppercase tracking-wide text-muted">
            {health?.store || 'unknown'}
          </span>
        </div>
      </div>
    </Section>
  )
}

// StorageCard renders the recordings-volume disk usage, with a usage bar. On a
// probe error the health payload carries {path,error} instead of usage fields.
function StorageCard({ storage }) {
  const hasError = storage && storage.error
  const pct =
    storage && typeof storage.used_percent === 'number'
      ? storage.used_percent
      : null
  return (
    <Section title="Storage" subtitle="Recordings volume disk usage">
      {!storage ? (
        <p className="text-sm text-faint">No storage data reported.</p>
      ) : hasError ? (
        <div className="space-y-1">
          <Field label="Path" value={storage.path} mono />
          <p className="text-sm text-warn">{storage.error}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted">{storage.path}</span>
            {pct != null && (
              <span className="text-sm font-medium text-gray-200">
                {pct.toFixed(1)}% used
              </span>
            )}
          </div>
          {pct != null && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
              <div
                className={`h-full rounded-full ${usageColor(pct)}`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          )}
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-3">
            <Field label="Total" value={fmtBytes(storage.total_bytes)} />
            <Field label="Used" value={fmtBytes(storage.used_bytes)} />
            <Field label="Free" value={fmtBytes(storage.free_bytes)} />
          </dl>
        </div>
      )}
    </Section>
  )
}

// RaidCard lists software-RAID arrays. An empty array means "no software RAID on
// this box" (a bare disk); {error} means the probe itself failed.
function RaidCard({ raid }) {
  const hasError = raid && !Array.isArray(raid) && raid.error
  const arrays = Array.isArray(raid) ? raid : []
  return (
    <Section title="RAID" subtitle="Software array health">
      {hasError ? (
        <p className="text-sm text-warn">{raid.error}</p>
      ) : arrays.length === 0 ? (
        <p className="text-sm text-faint">
          No software RAID arrays detected on this node.
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-elevated text-left text-xs uppercase tracking-wide text-faint">
                <th className="px-3 py-2 font-medium">Device</th>
                <th className="px-3 py-2 font-medium">Level</th>
                <th className="px-3 py-2 font-medium">Health</th>
                <th className="px-3 py-2 font-medium">Devices</th>
                <th className="px-3 py-2 font-medium">Rebuild</th>
              </tr>
            </thead>
            <tbody>
              {arrays.map((a) => (
                <tr key={a.device} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 font-mono text-gray-200">{a.device}</td>
                  <td className="px-3 py-2 text-muted">{a.level || '—'}</td>
                  <td className="px-3 py-2">
                    <RaidHealthBadge health={a.health} />
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {a.working_devices}/{a.total_devices}
                    {a.failed_devices > 0 && (
                      <span className="ml-1 text-danger">
                        ({a.failed_devices} failed)
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {a.rebuild_percent != null
                      ? `${a.rebuild_percent}%`
                      : a.rebuild_status || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// AuditCard explains the audit trail. The node persists an append-only
// audit_log for every write (logins, user + camera + storage changes), but that
// list is not currently exposed over the estate API — so we surface where it
// lives rather than an empty table.
function AuditCard({ user }) {
  return (
    <Section title="Audit trail" subtitle="Configuration and access events">
      <div className="rounded-md border border-border bg-elevated px-4 py-3 text-sm text-muted">
        This node keeps an append-only audit log of every configuration and
        access event — logins, local-user changes, and camera / storage edits.
        The trail is not yet exposed through the console API; it is spooled to the
        central control plane and readable in the node's local SQLite store
        (<span className="font-mono text-xs text-gray-300">audit_log</span>).
      </div>
      {user && (
        <p className="mt-3 text-xs text-faint">
          Signed in as{' '}
          <span className="font-medium text-gray-300">
            {user.username || user.name || user.id}
          </span>
          {user.role ? ` · ${user.role}` : ''}.
        </p>
      )}
    </Section>
  )
}

/* ---------- presentational helpers ---------- */

function Section({ title, subtitle, children }) {
  return (
    <section className="card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-faint">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd
        className={`mt-0.5 text-sm text-gray-200 ${mono ? 'font-mono break-all' : ''}`}
      >
        {value ?? '—'}
      </dd>
    </div>
  )
}

function StatusTile({ label, ok }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-elevated px-3 py-2.5">
      <span className="text-sm text-gray-300">{label}</span>
      <span
        className={`inline-flex items-center gap-1.5 text-xs font-medium ${
          ok ? 'text-ok' : 'text-danger'
        }`}
      >
        <span
          className={`h-2 w-2 rounded-full ${ok ? 'bg-ok' : 'bg-danger'}`}
        />
        {ok ? 'OK' : 'Down'}
      </span>
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
        : 'border-border bg-elevated text-muted'
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {state || 'unknown'}
    </span>
  )
}

function RaidHealthBadge({ health }) {
  const h = (health || 'unknown').toLowerCase()
  const tone =
    h === 'healthy'
      ? 'border-ok/40 bg-ok/10 text-ok'
      : h === 'rebuilding'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : h === 'degraded' || h === 'failed'
          ? 'border-danger/40 bg-danger/10 text-danger'
          : 'border-border bg-elevated text-muted'
  return (
    <span
      className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {health || 'unknown'}
    </span>
  )
}

function usageColor(pct) {
  if (pct >= 90) return 'bg-danger'
  if (pct >= 75) return 'bg-warn'
  return 'bg-accent'
}

/* ---------- formatting ---------- */

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / Math.pow(1024, i)
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString()
}
