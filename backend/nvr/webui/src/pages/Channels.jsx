import { useCallback, useEffect, useMemo, useState } from 'react'
import { estate } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'

// Channels is the camera-onboarding screen for the box-served console. It lists
// this node's cameras (GET /estate/cameras), supports create (POST), edit (PATCH)
// and delete (DELETE), and shows the selected camera's fields in a side panel.
// A search box narrows by name and — when placement.site_id is present on any
// camera — the list groups by site. Everything talks only to this node's own API.
export default function Channels() {
  const { user } = useAuth()
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(null) // {mode:'create'|'edit', camera}

  const readOnly = user?.role === 'viewer'

  // load fetches the full camera list. The list endpoint accepts a `q` filter but
  // we filter client-side too so the side panel + grouping stay in sync without a
  // round-trip per keystroke.
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await estate.get('/cameras')
      const items = Array.isArray(res?.items) ? res.items : []
      items.sort(sortCameras)
      setCameras(items)
    } catch (err) {
      setError(err?.message || 'Failed to load cameras')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Keep the selection valid as the list changes; default to the first camera.
  useEffect(() => {
    if (!cameras.length) {
      setSelectedId(null)
      return
    }
    setSelectedId((cur) =>
      cur && cameras.some((c) => c.id === cur) ? cur : cameras[0].id,
    )
  }, [cameras])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cameras
    return cameras.filter((c) => {
      const host = c.onvif?.host || ''
      return (
        (c.name || '').toLowerCase().includes(q) ||
        String(c.display_order ?? '').includes(q) ||
        host.toLowerCase().includes(q)
      )
    })
  }, [cameras, query])

  // Group by site when any camera carries a placement.site_id; otherwise render a
  // single flat group so the UI stays quiet for the common single-site node.
  const groups = useMemo(() => groupBySite(filtered), [filtered])
  const grouped = groups.length > 1

  const selected = useMemo(
    () => cameras.find((c) => c.id === selectedId) || null,
    [cameras, selectedId],
  )

  // ── mutations ──────────────────────────────────────────────────────────────

  async function handleSave(body, id) {
    if (id) {
      const updated = await estate.patch(`/cameras/${id}`, body)
      setCameras((cur) =>
        cur.map((c) => (c.id === id ? updated : c)).sort(sortCameras),
      )
      setSelectedId(updated.id)
    } else {
      const created = await estate.post('/cameras', body)
      setCameras((cur) => [...cur, created].sort(sortCameras))
      setSelectedId(created.id)
    }
    setForm(null)
  }

  async function handleDelete(camera) {
    if (
      !window.confirm(
        `Delete camera "${camera.name}"? Recorded footage is not removed, but the channel and its config will be.`,
      )
    ) {
      return
    }
    try {
      await estate.del(`/cameras/${camera.id}`)
      setCameras((cur) => cur.filter((c) => c.id !== camera.id))
    } catch (err) {
      setError(err?.message || 'Failed to delete camera')
    }
  }

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0">
      {/* List column */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-gray-100">Channels</h1>
            <p className="mt-0.5 text-sm text-muted">
              {cameras.length} camera{cameras.length === 1 ? '' : 's'} on this
              recorder
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                className="input w-56 pl-8"
                type="search"
                placeholder="Search name, channel, host…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="btn-ghost" onClick={load} title="Refresh">
              <RefreshIcon />
            </button>
            {!readOnly && (
              <button
                className="btn-primary"
                onClick={() => setForm({ mode: 'create', camera: null })}
              >
                <PlusIcon />
                Add camera
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}

          {loading ? (
            <div className="card p-12 text-center text-sm text-faint">
              Loading cameras…
            </div>
          ) : cameras.length === 0 ? (
            <EmptyState readOnly={readOnly} onAdd={() => setForm({ mode: 'create', camera: null })} />
          ) : filtered.length === 0 ? (
            <div className="card p-12 text-center text-sm text-faint">
              No cameras match “{query}”.
            </div>
          ) : (
            <div className="space-y-6">
              {groups.map((g) => (
                <div key={g.key}>
                  {grouped && (
                    <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-faint">
                      <SiteIcon />
                      {g.label}
                      <span className="text-faint/70">· {g.cameras.length}</span>
                    </div>
                  )}
                  <div className="overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-elevated/50 text-left text-xs uppercase tracking-wider text-faint">
                          <th className="px-3 py-2 font-medium">Ch</th>
                          <th className="px-3 py-2 font-medium">Name</th>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Address</th>
                          <th className="px-3 py-2 font-medium">Codec</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {g.cameras.map((c) => (
                          <CameraRow
                            key={c.id}
                            camera={c}
                            active={c.id === selectedId}
                            readOnly={readOnly}
                            onSelect={() => setSelectedId(c.id)}
                            onEdit={() => setForm({ mode: 'edit', camera: c })}
                            onDelete={() => handleDelete(c)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Detail side panel */}
      {selected && (
        <DetailPanel
          camera={selected}
          readOnly={readOnly}
          onEdit={() => setForm({ mode: 'edit', camera: selected })}
          onDelete={() => handleDelete(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {form && (
        <CameraFormModal
          mode={form.mode}
          camera={form.camera}
          onCancel={() => setForm(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}

// ── list row ───────────────────────────────────────────────────────────────

function CameraRow({ camera, active, readOnly, onSelect, onEdit, onDelete }) {
  const codec = camera.sub_stream_codec || firstProfileCodec(camera)
  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer border-b border-border/60 transition-colors last:border-b-0 ${
        active ? 'bg-elevated' : 'hover:bg-elevated/50'
      }`}
    >
      <td className="px-3 py-2.5 font-mono text-xs text-muted">
        {formatChannel(camera.display_order)}
      </td>
      <td className="px-3 py-2.5">
        <div className="font-medium text-gray-100">{camera.name}</div>
        {!camera.is_enabled && (
          <span className="text-xs text-faint">disabled</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <StatusBadge status={camera.status} enabled={camera.is_enabled} />
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-muted">
        {camera.onvif?.host
          ? `${camera.onvif.host}${camera.onvif.port ? ':' + camera.onvif.port : ''}`
          : '—'}
      </td>
      <td className="px-3 py-2.5 text-xs uppercase text-muted">
        {codec || '—'}
      </td>
      <td className="px-3 py-2.5 text-right">
        {!readOnly && (
          <div className="inline-flex items-center gap-1">
            <IconButton
              label="Edit"
              onClick={(e) => {
                e.stopPropagation()
                onEdit()
              }}
            >
              <EditIcon />
            </IconButton>
            <IconButton
              label="Delete"
              danger
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <TrashIcon />
            </IconButton>
          </div>
        )}
      </td>
    </tr>
  )
}

// ── detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ camera, readOnly, onEdit, onDelete, onClose }) {
  const rec = camera.recording || {}
  const onvif = camera.onvif || {}
  const profiles = camera.media_profiles || []
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-start justify-between border-b border-border px-4 py-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-100">
            {camera.name}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <StatusBadge status={camera.status} enabled={camera.is_enabled} />
            <span className="font-mono text-xs text-faint">
              {formatChannel(camera.display_order)}
            </span>
          </div>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        <FieldGroup title="Identity">
          <Field label="Name" value={camera.name} />
          <Field label="Enabled" value={camera.is_enabled ? 'Yes' : 'No'} />
          <Field label="Brand" value={camera.brand} />
          <Field label="Driver" value={camera.driver} />
          <Field label="Connection" value={camera.connection_type} />
        </FieldGroup>

        <FieldGroup title="Network / ONVIF">
          <Field label="Host" value={onvif.host} mono />
          <Field label="Port" value={onvif.port} mono />
          <Field label="User" value={onvif.user} mono />
          <Field
            label="Password"
            value={onvif.has_password ? 'set' : 'not set'}
          />
          <Field label="Profile token" value={onvif.profile_token} mono />
        </FieldGroup>

        <FieldGroup title="Recording">
          <Field label="Mode" value={rec.mode} />
          <Field
            label="Retention"
            value={rec.retention_days != null ? `${rec.retention_days} days` : null}
          />
          <Field label="Substream" value={rec.record_substream ? 'Yes' : 'No'} />
          <Field label="Audio" value={rec.audio_enabled ? 'On' : 'Off'} />
          <Field label="ANR" value={rec.anr_enabled ? 'On' : 'Off'} />
        </FieldGroup>

        {profiles.length > 0 && (
          <FieldGroup title={`Media profiles (${profiles.length})`}>
            {profiles.map((p) => (
              <div
                key={p.id}
                className="rounded-md border border-border bg-elevated/40 px-2.5 py-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-200">{p.name}</span>
                  <span className="text-xs uppercase text-faint">
                    {p.codec || '—'}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {[p.resolution, p.fps ? `${p.fps} fps` : null]
                    .filter(Boolean)
                    .join(' · ') || 'no media details'}
                </div>
              </div>
            ))}
          </FieldGroup>
        )}

        <FieldGroup title="Placement">
          <Field label="Site" value={camera.placement?.site_id} mono />
          <Field label="Floor" value={camera.placement?.floor_id} mono />
          <Field label="Zone" value={camera.placement?.zone_id} mono />
        </FieldGroup>
      </div>

      {!readOnly && (
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <button className="btn-ghost flex-1" onClick={onEdit}>
            <EditIcon />
            Edit
          </button>
          <button
            className="btn border border-danger/40 text-danger hover:bg-danger/10"
            onClick={onDelete}
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </aside>
  )
}

// ── create / edit modal ──────────────────────────────────────────────────────

const RECORDING_MODES = ['continuous', 'schedule', 'motion', 'manual']

function CameraFormModal({ mode, camera, onCancel, onSave }) {
  const editing = mode === 'edit'
  const [values, setValues] = useState(() => initialForm(camera))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function set(key, value) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function submit(e) {
    e.preventDefault()
    setError('')
    if (!values.name.trim()) {
      setError('Name is required')
      return
    }
    setBusy(true)
    try {
      await onSave(buildBody(values, editing), editing ? camera.id : null)
    } catch (err) {
      setError(err?.message || 'Failed to save camera')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card flex max-h-[90vh] w-full max-w-lg flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold text-gray-100">
            {editing ? `Edit ${camera.name}` : 'Add camera'}
          </h2>
          <IconButton label="Close" onClick={onCancel}>
            <CloseIcon />
          </IconButton>
        </div>

        <form onSubmit={submit} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-4">
            <FormRow label="Name" required>
              <input
                className="input"
                autoFocus
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="Lobby entrance"
              />
            </FormRow>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label="Brand">
                <input
                  className="input"
                  value={values.brand}
                  onChange={(e) => set('brand', e.target.value)}
                  placeholder="onvif"
                />
              </FormRow>
              <FormRow label="Channel #">
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={values.displayOrder}
                  onChange={(e) => set('displayOrder', e.target.value)}
                  placeholder="0"
                />
              </FormRow>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label="Host / IP">
                <input
                  className="input"
                  value={values.host}
                  onChange={(e) => set('host', e.target.value)}
                  placeholder="192.168.1.64"
                />
              </FormRow>
              <FormRow label="ONVIF port">
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={values.port}
                  onChange={(e) => set('port', e.target.value)}
                  placeholder="80"
                />
              </FormRow>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label="Username">
                <input
                  className="input"
                  autoComplete="off"
                  value={values.user}
                  onChange={(e) => set('user', e.target.value)}
                  placeholder="admin"
                />
              </FormRow>
              <FormRow
                label={editing ? 'Password (leave blank to keep)' : 'Password'}
              >
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={values.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder="••••••••"
                />
              </FormRow>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormRow label="Recording mode">
                <select
                  className="input"
                  value={values.recordingMode}
                  onChange={(e) => set('recordingMode', e.target.value)}
                >
                  {RECORDING_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </FormRow>
              <FormRow label="Retention (days)">
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={values.retentionDays}
                  onChange={(e) => set('retentionDays', e.target.value)}
                  placeholder="30"
                />
              </FormRow>
            </div>

            <FormRow label="Site ID (optional)">
              <input
                className="input"
                value={values.siteId}
                onChange={(e) => set('siteId', e.target.value)}
                placeholder="site-uuid — groups the channel list"
              />
            </FormRow>

            <label className="flex items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border bg-surface accent-accent"
                checked={values.isEnabled}
                onChange={(e) => set('isEnabled', e.target.checked)}
              />
              Enabled
            </label>

            {error && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}
          </div>
        </form>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={submit}
            disabled={busy || !values.name.trim()}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add camera'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── small presentational helpers ─────────────────────────────────────────────

function StatusBadge({ status, enabled }) {
  if (enabled === false) {
    return <Pill tone="faint" label="Disabled" />
  }
  const s = (status || 'unknown').toLowerCase()
  const tone =
    s === 'online' || s === 'connected' || s === 'recording'
      ? 'ok'
      : s === 'connecting' || s === 'pending'
        ? 'warn'
        : s === 'offline' || s === 'error' || s === 'disconnected'
          ? 'danger'
          : 'faint'
  return <Pill tone={tone} label={status || 'unknown'} />
}

function Pill({ tone, label }) {
  const tones = {
    ok: 'border-ok/40 bg-ok/10 text-ok',
    warn: 'border-warn/40 bg-warn/10 text-warn',
    danger: 'border-danger/40 bg-danger/10 text-danger',
    faint: 'border-border bg-elevated text-faint',
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs capitalize ${tones[tone] || tones.faint}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function FieldGroup({ title, children }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, value, mono }) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-faint">{label}</span>
      <span
        className={`truncate text-right text-gray-200 ${mono ? 'font-mono text-xs' : ''} ${empty ? 'text-faint' : ''}`}
      >
        {empty ? '—' : String(value)}
      </span>
    </div>
  )
}

function FormRow({ label, required, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {children}
    </div>
  )
}

function EmptyState({ readOnly, onAdd }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 p-12 text-center">
      <CameraGlyph />
      <div className="text-sm font-medium text-gray-200">No cameras yet</div>
      <p className="max-w-xs text-sm text-faint">
        Onboard a camera to start recording on this appliance. It stays local to
        this node even when the central system is offline.
      </p>
      {!readOnly && (
        <button className="btn-primary mt-1" onClick={onAdd}>
          <PlusIcon />
          Add your first camera
        </button>
      )}
    </div>
  )
}

function IconButton({ label, danger, onClick, children }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted transition-colors hover:border-border hover:bg-elevated ${
        danger ? 'hover:text-danger' : 'hover:text-gray-100'
      }`}
    >
      {children}
    </button>
  )
}

// ── data helpers ─────────────────────────────────────────────────────────────

// initialForm seeds the modal state from an existing camera (edit) or blank
// defaults (create). Password is never pre-filled — the server only exposes
// has_password, so an unchanged edit leaves it blank and the PATCH omits it.
function initialForm(camera) {
  const rec = camera?.recording || {}
  const onvif = camera?.onvif || {}
  return {
    name: camera?.name || '',
    brand: camera?.brand || '',
    displayOrder:
      camera?.display_order != null ? String(camera.display_order) : '',
    host: onvif.host || '',
    port: onvif.port != null ? String(onvif.port) : '',
    user: onvif.user || '',
    password: '',
    recordingMode: rec.mode || 'continuous',
    retentionDays: rec.retention_days != null ? String(rec.retention_days) : '',
    siteId: camera?.placement?.site_id || '',
    isEnabled: camera?.is_enabled ?? true,
  }
}

// buildBody assembles the create/patch payload matching cameraCreateBody /
// cameraUpdateBody. Sub-objects (onvif/recording/placement) are only included
// when they carry a value so a PATCH never clobbers an untouched field.
function buildBody(v, editing) {
  const body = {
    name: v.name.trim(),
    is_enabled: v.isEnabled,
  }
  if (v.brand.trim()) body.brand = v.brand.trim()
  if (v.displayOrder !== '') body.display_order = Number(v.displayOrder)

  const onvif = {}
  if (v.host.trim()) onvif.host = v.host.trim()
  if (v.port !== '') onvif.port = Number(v.port)
  if (v.user.trim()) onvif.user = v.user.trim()
  if (v.password) onvif.password = v.password
  if (Object.keys(onvif).length) body.onvif = onvif

  const recording = {}
  if (v.recordingMode) recording.mode = v.recordingMode
  if (v.retentionDays !== '') recording.retention_days = Number(v.retentionDays)
  if (Object.keys(recording).length) body.recording = recording

  // Placement: send site_id (even when cleared on edit, so grouping updates).
  const site = v.siteId.trim()
  if (site || editing) body.placement = { site_id: site || null }

  return body
}

function sortCameras(a, b) {
  const ao = a.display_order ?? Number.MAX_SAFE_INTEGER
  const bo = b.display_order ?? Number.MAX_SAFE_INTEGER
  if (ao !== bo) return ao - bo
  return (a.name || '').localeCompare(b.name || '')
}

// groupBySite buckets cameras by placement.site_id. When no camera carries a site
// it returns a single unlabeled group so the flat list renders unchanged.
function groupBySite(cameras) {
  const hasSite = cameras.some((c) => c.placement?.site_id)
  if (!hasSite) {
    return [{ key: '__all__', label: 'All cameras', cameras }]
  }
  const buckets = new Map()
  for (const c of cameras) {
    const site = c.placement?.site_id || '__unassigned__'
    if (!buckets.has(site)) buckets.set(site, [])
    buckets.get(site).push(c)
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === '__unassigned__') return 1
      if (b === '__unassigned__') return -1
      return a.localeCompare(b)
    })
    .map(([key, cams]) => ({
      key,
      label: key === '__unassigned__' ? 'Unassigned' : `Site ${shortId(key)}`,
      cameras: cams,
    }))
}

function shortId(id) {
  return id && id.length > 8 ? id.slice(0, 8) : id
}

function firstProfileCodec(camera) {
  const p = (camera.media_profiles || []).find((mp) => mp.codec)
  return p?.codec || ''
}

function formatChannel(order) {
  if (order === null || order === undefined) return '—'
  return `CH ${order}`
}

// ── icons (stroke, currentColor) ─────────────────────────────────────────────

function icon(children, props = {}) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}
function PlusIcon() {
  return icon(
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>,
  )
}
function SearchIcon({ className }) {
  return icon(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    { className, width: 15, height: 15 },
  )
}
function RefreshIcon() {
  return icon(
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>,
  )
}
function EditIcon() {
  return icon(
    <>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </>,
  )
}
function TrashIcon() {
  return icon(
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>,
  )
}
function CloseIcon() {
  return icon(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
  )
}
function SiteIcon() {
  return icon(
    <>
      <path d="M3 21h18" />
      <path d="M5 21V7l8-4v18" />
      <path d="M19 21V11l-6-4" />
    </>,
    { width: 13, height: 13 },
  )
}
function CameraGlyph() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-faint"
    >
      <path d="M23 7l-7 5 7 5V7z" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </svg>
  )
}
