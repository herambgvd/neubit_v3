import { useCallback, useEffect, useMemo, useState } from 'react'
import { estate } from '../lib/api.js'

// Storage is the node-authoritative disk screen: recordings-volume usage, software
// RAID health, storage-pool CRUD, and tiering-rule CRUD. It talks only to this
// node's own /estate/storage/* API, so it works with the central plane offline.
//
// Layout, top → bottom, follows an operator's triage order: "is the disk full?"
// (usage) → "is the array healthy?" (RAID) → the configuration that drives them
// (pools, then tier rules that move footage between pools).
export default function Storage() {
  const [usage, setUsage] = useState(null)
  const [raid, setRaid] = useState(null)
  const [pools, setPools] = useState([])
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // editing state: { kind: 'pool'|'rule', item } for the modal editor.
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [u, ra, p, tr] = await Promise.all([
        estate.get('/storage/usage'),
        estate.get('/storage/raid'),
        estate.get('/storage/pools'),
        estate.get('/storage/tier-rules'),
      ])
      setUsage(u)
      setRaid(ra)
      setPools(p?.items || [])
      setRules(tr?.items || [])
    } catch (e) {
      setError(e?.message || 'failed to load storage')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const poolName = useCallback(
    (id) => pools.find((p) => p.id === id)?.name || id || '—',
    [pools],
  )

  async function deletePool(p) {
    if (!confirm(`Delete storage pool "${p.name}"? This cannot be undone.`)) return
    try {
      await estate.del(`/storage/pools/${p.id}`)
      load()
    } catch (e) {
      setError(e?.message || 'failed to delete pool')
    }
  }

  async function deleteRule(t) {
    if (!confirm(`Delete tier rule "${t.name}"?`)) return
    try {
      await estate.del(`/storage/tier-rules/${t.id}`)
      load()
    } catch (e) {
      setError(e?.message || 'failed to delete rule')
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Storage</h1>
          <p className="mt-1 text-sm text-muted">
            Recording volume, RAID health, pools, and tiering — all node-local.
          </p>
        </div>
        <button className="btn-ghost" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && !usage ? (
        <div className="card flex items-center justify-center p-12 text-sm text-faint">
          Loading storage…
        </div>
      ) : (
        <>
          <UsageCard usage={usage} />
          <RaidCard raid={raid} />
          <PoolsCard
            pools={pools}
            onNew={() => setEditing({ kind: 'pool', item: null })}
            onEdit={(p) => setEditing({ kind: 'pool', item: p })}
            onDelete={deletePool}
          />
          <RulesCard
            rules={rules}
            pools={pools}
            poolName={poolName}
            onNew={() => setEditing({ kind: 'rule', item: null })}
            onEdit={(t) => setEditing({ kind: 'rule', item: t })}
            onDelete={deleteRule}
          />
        </>
      )}

      {editing?.kind === 'pool' && (
        <PoolEditor
          pool={editing.item}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
          onError={setError}
        />
      )}
      {editing?.kind === 'rule' && (
        <RuleEditor
          rule={editing.item}
          pools={pools}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
          onError={setError}
        />
      )}
    </div>
  )
}

// ── Disk usage ─────────────────────────────────────────────────────────────────

function UsageCard({ usage }) {
  if (!usage) return null
  const reachable = usage.reachable !== false
  const pct = clampPct(usage.used_percent)
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-100">Recording volume</h2>
        <code className="text-xs text-faint">{usage.path || '—'}</code>
      </div>

      {!reachable ? (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          Volume unreachable{usage.error ? ` — ${usage.error}` : ''}
        </div>
      ) : (
        <>
          <UsageBar pct={pct} />
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Used" value={formatBytes(usage.used_bytes)} />
            <Metric label="Free" value={formatBytes(usage.free_bytes)} />
            <Metric label="Total" value={formatBytes(usage.total_bytes)} />
            <Metric label="Used %" value={`${pct.toFixed(1)}%`} />
          </div>
        </>
      )}
    </section>
  )
}

function UsageBar({ pct }) {
  const tone = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-accent'
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-elevated">
      <div
        className={`h-full rounded-full ${tone} transition-all`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── RAID ───────────────────────────────────────────────────────────────────────

function RaidCard({ raid }) {
  const arrays = raid?.arrays || []
  const available = raid?.available && arrays.length > 0
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-100">RAID arrays</h2>
        {!available && (
          <span className="text-xs text-faint">No software RAID detected</span>
        )}
      </div>

      {!available ? (
        <p className="text-sm text-faint">
          {raid?.reason
            ? `RAID unavailable — ${raid.reason}`
            : 'This box has no monitored RAID arrays. Direct disks are shown under Recording volume.'}
        </p>
      ) : (
        <div className="space-y-3">
          {arrays.map((a) => (
            <RaidArrayRow key={a.device} array={a} />
          ))}
        </div>
      )}
    </section>
  )
}

function RaidArrayRow({ array: a }) {
  const rebuilding = a.health === 'rebuilding' && a.rebuild_percent != null
  return (
    <div className="rounded-md border border-border bg-elevated p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="text-sm text-gray-100">{a.device}</code>
          <span className="text-xs text-muted">{a.level}</span>
        </div>
        <HealthBadge health={a.health} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>
          Devices{' '}
          <span className="text-gray-200">
            {a.working_devices}/{a.total_devices}
          </span>
        </span>
        {a.failed_devices > 0 && (
          <span className="text-danger">Failed {a.failed_devices}</span>
        )}
        {a.state && <span>State {a.state}</span>}
      </div>
      {rebuilding && (
        <div className="mt-2">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>{a.rebuild_status || 'Rebuilding'}</span>
            <span className="text-gray-200">{a.rebuild_percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-warn transition-all"
              style={{ width: `${clampPct(a.rebuild_percent)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function HealthBadge({ health }) {
  const map = {
    healthy: 'border-ok/40 bg-ok/10 text-ok',
    degraded: 'border-warn/40 bg-warn/10 text-warn',
    rebuilding: 'border-accent/40 bg-accent/10 text-accent',
    failed: 'border-danger/40 bg-danger/10 text-danger',
  }
  const tone = map[health] || 'border-border bg-elevated text-muted'
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {health || 'unknown'}
    </span>
  )
}

// ── Storage pools ────────────────────────────────────────────────────────────

function PoolsCard({ pools, onNew, onEdit, onDelete }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-100">Storage pools</h2>
        <button className="btn-primary" onClick={onNew}>
          Add pool
        </button>
      </div>

      {pools.length === 0 ? (
        <p className="text-sm text-faint">
          No pools configured. Recordings fall back to the default volume.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Location</Th>
                <Th className="text-right">Priority</Th>
                <Th>State</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-0">
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-100">{p.name}</span>
                      {p.is_default && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                          default
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <span className="uppercase text-muted">{p.pool_type}</span>
                  </Td>
                  <Td>
                    <code className="text-xs text-faint">
                      {poolLocation(p)}
                    </code>
                  </Td>
                  <Td className="text-right tabular-nums">{p.priority}</Td>
                  <Td>
                    {p.is_active ? (
                      <span className="text-ok">active</span>
                    ) : (
                      <span className="text-faint">inactive</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex gap-2">
                      <button
                        className="text-xs text-accent hover:underline"
                        onClick={() => onEdit(p)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-xs text-danger hover:underline"
                        onClick={() => onDelete(p)}
                      >
                        Delete
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Tier rules ───────────────────────────────────────────────────────────────

function RulesCard({ rules, pools, poolName, onNew, onEdit, onDelete }) {
  const canAdd = pools.length >= 2
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">Tiering rules</h2>
          <p className="mt-0.5 text-xs text-muted">
            Move footage from a source pool to a colder target after it ages.
          </p>
        </div>
        <button className="btn-primary" onClick={onNew} disabled={!canAdd}>
          Add rule
        </button>
      </div>

      {!canAdd && (
        <p className="mb-3 text-xs text-faint">
          Add at least two pools to configure tiering.
        </p>
      )}

      {rules.length === 0 ? (
        <p className="text-sm text-faint">No tiering rules configured.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <Th>Name</Th>
                <Th>Source</Th>
                <Th>Target</Th>
                <Th className="text-right">After</Th>
                <Th>Enabled</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rules.map((t) => (
                <tr key={t.id} className="border-b border-border/60 last:border-0">
                  <Td className="text-gray-100">{t.name}</Td>
                  <Td className="text-muted">{poolName(t.source_pool_id)}</Td>
                  <Td className="text-muted">{poolName(t.target_pool_id)}</Td>
                  <Td className="text-right tabular-nums">
                    {formatAge(t.after_age_hours)}
                  </Td>
                  <Td>
                    {t.enabled ? (
                      <span className="text-ok">yes</span>
                    ) : (
                      <span className="text-faint">no</span>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="inline-flex gap-2">
                      <button
                        className="text-xs text-accent hover:underline"
                        onClick={() => onEdit(t)}
                      >
                        Edit
                      </button>
                      <button
                        className="text-xs text-danger hover:underline"
                        onClick={() => onDelete(t)}
                      >
                        Delete
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Pool editor modal ──────────────────────────────────────────────────────────

const POOL_TYPES = [
  { value: 'local', label: 'Local disk' },
  { value: 'nas', label: 'NAS (NFS/SMB)' },
  { value: 's3', label: 'S3 / object' },
]

function PoolEditor({ pool, onClose, onSaved, onError }) {
  const isNew = !pool
  const [form, setForm] = useState(() => ({
    name: pool?.name || '',
    pool_type: pool?.pool_type || 'local',
    path: pool?.path || '',
    priority: pool?.priority ?? 0,
    is_default: pool?.is_default ?? false,
    is_active: pool?.is_active ?? true,
    // NAS
    nas_server: pool?.nas_server || '',
    nas_share: pool?.nas_share || '',
    nas_protocol: pool?.nas_protocol || 'nfs',
    nas_username: pool?.nas_username || '',
    nas_password: '',
    nas_domain: pool?.nas_domain || '',
    // S3
    s3_endpoint: pool?.s3_endpoint || '',
    s3_bucket: pool?.s3_bucket || '',
    s3_region: pool?.s3_region || '',
    s3_access_key: pool?.s3_access_key || '',
    s3_secret_key: '',
    s3_use_ssl: pool?.s3_use_ssl ?? true,
  }))
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) {
      onError('Pool name is required')
      return
    }
    setBusy(true)
    try {
      const body = buildPoolBody(form)
      if (isNew) await estate.post('/storage/pools', body)
      else await estate.patch(`/storage/pools/${pool.id}`, body)
      onSaved()
    } catch (e) {
      onError(e?.message || 'failed to save pool')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isNew ? 'Add storage pool' : `Edit ${pool.name}`}
      onClose={onClose}
      onSubmit={save}
      busy={busy}
    >
      <Field label="Name">
        <input
          className="input"
          value={form.name}
          onChange={(e) => set('name')(e.target.value)}
          placeholder="Cold archive"
          autoFocus
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select
            className="input"
            value={form.pool_type}
            onChange={(e) => set('pool_type')(e.target.value)}
          >
            {POOL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" hint="Lower is preferred first">
          <input
            className="input"
            type="number"
            value={form.priority}
            onChange={(e) => set('priority')(numOr0(e.target.value))}
          />
        </Field>
      </div>

      {form.pool_type === 'local' && (
        <Field label="Path" hint="Mount path on the recorder box">
          <input
            className="input"
            value={form.path}
            onChange={(e) => set('path')(e.target.value)}
            placeholder="/recordings/cold"
          />
        </Field>
      )}

      {form.pool_type === 'nas' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Server">
              <input
                className="input"
                value={form.nas_server}
                onChange={(e) => set('nas_server')(e.target.value)}
                placeholder="10.0.0.5"
              />
            </Field>
            <Field label="Protocol">
              <select
                className="input"
                value={form.nas_protocol}
                onChange={(e) => set('nas_protocol')(e.target.value)}
              >
                <option value="nfs">NFS</option>
                <option value="smb">SMB / CIFS</option>
              </select>
            </Field>
          </div>
          <Field label="Share">
            <input
              className="input"
              value={form.nas_share}
              onChange={(e) => set('nas_share')(e.target.value)}
              placeholder="/export/cctv"
            />
          </Field>
          {form.nas_protocol === 'smb' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Username">
                <input
                  className="input"
                  value={form.nas_username}
                  onChange={(e) => set('nas_username')(e.target.value)}
                />
              </Field>
              <Field label="Domain">
                <input
                  className="input"
                  value={form.nas_domain}
                  onChange={(e) => set('nas_domain')(e.target.value)}
                />
              </Field>
            </div>
          )}
          <Field
            label="Password"
            hint={pool?.nas_has_password ? 'Leave blank to keep existing' : undefined}
          >
            <input
              className="input"
              type="password"
              value={form.nas_password}
              onChange={(e) => set('nas_password')(e.target.value)}
              placeholder={pool?.nas_has_password ? '••••••••' : ''}
            />
          </Field>
        </div>
      )}

      {form.pool_type === 's3' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Endpoint">
              <input
                className="input"
                value={form.s3_endpoint}
                onChange={(e) => set('s3_endpoint')(e.target.value)}
                placeholder="s3.amazonaws.com"
              />
            </Field>
            <Field label="Region">
              <input
                className="input"
                value={form.s3_region}
                onChange={(e) => set('s3_region')(e.target.value)}
                placeholder="us-east-1"
              />
            </Field>
          </div>
          <Field label="Bucket">
            <input
              className="input"
              value={form.s3_bucket}
              onChange={(e) => set('s3_bucket')(e.target.value)}
            />
          </Field>
          <Field label="Access key">
            <input
              className="input"
              value={form.s3_access_key}
              onChange={(e) => set('s3_access_key')(e.target.value)}
            />
          </Field>
          <Field
            label="Secret key"
            hint={pool?.s3_has_secret_key ? 'Leave blank to keep existing' : undefined}
          >
            <input
              className="input"
              type="password"
              value={form.s3_secret_key}
              onChange={(e) => set('s3_secret_key')(e.target.value)}
              placeholder={pool?.s3_has_secret_key ? '••••••••' : ''}
            />
          </Field>
          <Toggle
            label="Use TLS"
            checked={form.s3_use_ssl}
            onChange={set('s3_use_ssl')}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-5 pt-1">
        <Toggle
          label="Default pool"
          checked={form.is_default}
          onChange={set('is_default')}
        />
        <Toggle label="Active" checked={form.is_active} onChange={set('is_active')} />
      </div>
    </Modal>
  )
}

// buildPoolBody trims the form to only the fields relevant to the chosen pool type,
// and omits blank secrets so the backend keeps the existing encrypted value.
function buildPoolBody(f) {
  const body = {
    name: f.name.trim(),
    pool_type: f.pool_type,
    priority: numOr0(f.priority),
    is_default: !!f.is_default,
    is_active: !!f.is_active,
  }
  if (f.pool_type === 'local') {
    body.path = f.path.trim()
  } else if (f.pool_type === 'nas') {
    body.nas_server = f.nas_server.trim()
    body.nas_share = f.nas_share.trim()
    body.nas_protocol = f.nas_protocol
    body.nas_username = f.nas_username.trim()
    body.nas_domain = f.nas_domain.trim()
    if (f.nas_password) body.nas_password = f.nas_password
  } else if (f.pool_type === 's3') {
    body.s3_endpoint = f.s3_endpoint.trim()
    body.s3_bucket = f.s3_bucket.trim()
    body.s3_region = f.s3_region.trim()
    body.s3_access_key = f.s3_access_key.trim()
    body.s3_use_ssl = !!f.s3_use_ssl
    if (f.s3_secret_key) body.s3_secret_key = f.s3_secret_key
  }
  return body
}

// ── Tier-rule editor modal ─────────────────────────────────────────────────────

function RuleEditor({ rule, pools, onClose, onSaved, onError }) {
  const isNew = !rule
  const [form, setForm] = useState(() => ({
    name: rule?.name || '',
    source_pool_id: rule?.source_pool_id || pools[0]?.id || '',
    target_pool_id:
      rule?.target_pool_id || pools.find((p) => p.id !== pools[0]?.id)?.id || '',
    after_age_hours: rule?.after_age_hours ?? 168,
    enabled: rule?.enabled ?? true,
  }))
  const [busy, setBusy] = useState(false)

  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) {
      onError('Rule name is required')
      return
    }
    if (!form.source_pool_id || !form.target_pool_id) {
      onError('Source and target pools are required')
      return
    }
    if (form.source_pool_id === form.target_pool_id) {
      onError('Source and target pools must differ')
      return
    }
    setBusy(true)
    try {
      const body = {
        name: form.name.trim(),
        source_pool_id: form.source_pool_id,
        target_pool_id: form.target_pool_id,
        after_age_hours: numOr0(form.after_age_hours),
        enabled: !!form.enabled,
      }
      if (isNew) await estate.post('/storage/tier-rules', body)
      else await estate.patch(`/storage/tier-rules/${rule.id}`, body)
      onSaved()
    } catch (e) {
      onError(e?.message || 'failed to save rule')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isNew ? 'Add tiering rule' : `Edit ${rule.name}`}
      onClose={onClose}
      onSubmit={save}
      busy={busy}
    >
      <Field label="Name">
        <input
          className="input"
          value={form.name}
          onChange={(e) => set('name')(e.target.value)}
          placeholder="Age footage to cold storage"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Source pool">
          <select
            className="input"
            value={form.source_pool_id}
            onChange={(e) => set('source_pool_id')(e.target.value)}
          >
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target pool">
          <select
            className="input"
            value={form.target_pool_id}
            onChange={(e) => set('target_pool_id')(e.target.value)}
          >
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Move after (hours)" hint={ageHint(form.after_age_hours)}>
        <input
          className="input"
          type="number"
          min="0"
          value={form.after_age_hours}
          onChange={(e) => set('after_age_hours')(numOr0(e.target.value))}
        />
      </Field>
      <Toggle label="Enabled" checked={form.enabled} onChange={set('enabled')} />
    </Modal>
  )
}

// ── Shared primitives ──────────────────────────────────────────────────────────

function Modal({ title, children, onClose, onSubmit, busy }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
          <button className="text-muted hover:text-gray-200" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="space-y-4">{children}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={onSubmit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  )
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-border bg-surface text-accent focus:ring-accent/40"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5 text-sm font-medium text-gray-100 tabular-nums">
        {value}
      </div>
    </div>
  )
}

function Th({ children, className = '' }) {
  return <th className={`px-2 py-2 font-medium ${className}`}>{children}</th>
}

function Td({ children, className = '' }) {
  return <td className={`px-2 py-2.5 align-middle ${className}`}>{children}</td>
}

// ── formatting helpers ─────────────────────────────────────────────────────────

function clampPct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

function numOr0(v) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const val = n / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatAge(hours) {
  const h = Number(hours)
  if (!Number.isFinite(h) || h <= 0) return '0h'
  if (h % 24 === 0) {
    const d = h / 24
    return `${d}d`
  }
  return `${h}h`
}

function ageHint(hours) {
  const h = Number(hours)
  if (!Number.isFinite(h) || h <= 0) return undefined
  const d = (h / 24).toFixed(h % 24 === 0 ? 0 : 1)
  return `≈ ${d} day${d === '1' ? '' : 's'}`
}

function poolLocation(p) {
  if (p.pool_type === 'local') return p.path || '—'
  if (p.pool_type === 'nas') {
    const host = p.nas_server || '?'
    const share = p.nas_share || ''
    return `${(p.nas_protocol || 'nas').toUpperCase()} ${host}${share}`
  }
  if (p.pool_type === 's3') {
    return `${p.s3_bucket || '?'}${p.s3_region ? ` (${p.s3_region})` : ''}`
  }
  return '—'
}
