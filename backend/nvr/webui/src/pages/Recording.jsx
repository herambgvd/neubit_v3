import { useCallback, useEffect, useMemo, useState } from 'react'
import { estate } from '../lib/api.js'

// Recording is the per-camera recording-config screen. It talks only to this
// node's own estate API:
//   GET  /estate/cameras                       → the camera list (left rail)
//   GET  /estate/cameras/{id}/recording        → the selected camera's config
//   PUT  /estate/cameras/{id}/recording        → save (partial config patch)
//   POST /estate/cameras/{id}/recording/start  → manual start
//   POST /estate/cameras/{id}/recording/stop   → manual stop
//
// Recording modes: continuous | schedule | motion | manual. A camera in a
// non-manual mode is configured to record on its own; a manual camera records
// only while an operator has triggered start. The list rail shows a live-ish
// "recording" badge derived from the camera's mode (and updated when the operator
// hits start/stop here), so the operator can see at a glance which cameras record.

const MODES = [
  { value: 'continuous', label: 'Continuous', hint: 'Always recording' },
  { value: 'schedule', label: 'Schedule', hint: 'Records on a schedule' },
  { value: 'motion', label: 'Motion', hint: 'Records on motion' },
  { value: 'manual', label: 'Manual', hint: 'Records only when started' },
]

// A camera is considered "recording" from its config alone when its mode keeps it
// recording without an operator trigger. Manual cameras are recording only while
// an explicit start is in effect (tracked in triggered state).
const AUTO_RECORDING_MODES = new Set(['continuous', 'schedule', 'motion'])

export default function Recording() {
  const [cameras, setCameras] = useState([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [query, setQuery] = useState('')

  // manualState maps camera id → boolean of the last manual start/stop the
  // operator triggered this session, so the badge reflects it immediately.
  const [manualState, setManualState] = useState({})

  const loadCameras = useCallback(async () => {
    setLoadingList(true)
    setListError('')
    try {
      const res = await estate.get('/cameras')
      const items = res?.items || []
      setCameras(items)
      setSelectedId((cur) => cur || (items.length ? items[0].id : null))
    } catch (err) {
      setListError(err?.message || 'Failed to load cameras')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    loadCameras()
  }, [loadCameras])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cameras
    return cameras.filter((c) => (c.name || '').toLowerCase().includes(q))
  }, [cameras, query])

  const isRecording = useCallback(
    (cam) => {
      if (cam.id in manualState) return manualState[cam.id]
      const mode = cam.recording?.mode
      return AUTO_RECORDING_MODES.has(mode)
    },
    [manualState],
  )

  // markTriggered records the operator's start/stop so the rail badge updates and
  // patches the selected camera's cached mode when a manual toggle implies it.
  const markTriggered = useCallback((id, on) => {
    setManualState((s) => ({ ...s, [id]: on }))
  }, [])

  // onSaved folds a freshly-saved config back into the list rail so the badge and
  // mode stay in sync without a full reload.
  const onSaved = useCallback((id, config) => {
    setCameras((list) =>
      list.map((c) =>
        c.id === id ? { ...c, recording: { ...c.recording, ...config } } : c,
      ),
    )
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-lg font-semibold text-gray-100">Recording</h1>
        <p className="mt-1 text-sm text-muted">
          Per-camera recording configuration and manual start / stop.
        </p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[20rem_1fr]">
        {/* ── camera rail ─────────────────────────────────────────────── */}
        <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
          <div className="p-3">
            <input
              className="input"
              type="search"
              placeholder="Search cameras…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {loadingList ? (
              <p className="px-1 py-4 text-sm text-faint">Loading cameras…</p>
            ) : listError ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {listError}
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-1 py-4 text-sm text-faint">
                {cameras.length === 0 ? 'No cameras on this node.' : 'No matches.'}
              </p>
            ) : (
              <ul className="space-y-1">
                {filtered.map((cam) => (
                  <li key={cam.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(cam.id)}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                        cam.id === selectedId
                          ? 'border-accent/60 bg-elevated'
                          : 'border-transparent hover:bg-elevated'
                      }`}
                    >
                      <RecDot on={isRecording(cam)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-gray-100">
                          {cam.name || cam.id}
                        </span>
                        <span className="block truncate text-xs text-faint">
                          {modeLabel(cam.recording?.mode)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* ── config editor ──────────────────────────────────────────── */}
        <main className="min-h-0 overflow-y-auto p-6">
          {selectedId ? (
            <CameraRecording
              key={selectedId}
              cameraId={selectedId}
              cameraName={
                cameras.find((c) => c.id === selectedId)?.name || selectedId
              }
              onSaved={onSaved}
              onTriggered={markTriggered}
            />
          ) : (
            <div className="card flex items-center justify-center p-12 text-sm text-faint">
              Select a camera to configure recording.
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// CameraRecording loads and edits one camera's recording config. It keeps a draft
// of the form and a saved baseline so it can show a dirty state and reset.
function CameraRecording({ cameraId, cameraName, onSaved, onTriggered }) {
  const [config, setConfig] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [triggering, setTriggering] = useState('') // '' | 'start' | 'stop'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const res = await estate.get(`/cameras/${cameraId}/recording`)
      setConfig(res)
      setDraft(toForm(res))
    } catch (err) {
      setError(err?.message || 'Failed to load recording config')
    } finally {
      setLoading(false)
    }
  }, [cameraId])

  useEffect(() => {
    load()
  }, [load])

  const dirty = useMemo(() => {
    if (!config || !draft) return false
    const base = toForm(config)
    return JSON.stringify(base) !== JSON.stringify(draft)
  }, [config, draft])

  function set(field, value) {
    setNotice('')
    setDraft((d) => ({ ...d, [field]: value }))
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!draft) return
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const payload = fromForm(draft)
      const res = await estate.put(`/cameras/${cameraId}/recording`, payload)
      setConfig(res)
      setDraft(toForm(res))
      onSaved?.(cameraId, res)
      setNotice('Recording configuration saved.')
    } catch (err) {
      setError(err?.message || 'Failed to save configuration')
    } finally {
      setSaving(false)
    }
  }

  async function handleTrigger(on) {
    setTriggering(on ? 'start' : 'stop')
    setError('')
    setNotice('')
    try {
      const res = await estate.post(
        `/cameras/${cameraId}/recording/${on ? 'start' : 'stop'}`,
        {},
      )
      onTriggered?.(cameraId, !!res?.recording)
      setNotice(on ? 'Recording started.' : 'Recording stopped.')
    } catch (err) {
      setError(err?.message || `Failed to ${on ? 'start' : 'stop'} recording`)
    } finally {
      setTriggering('')
    }
  }

  if (loading) {
    return (
      <div className="card p-12 text-center text-sm text-faint">
        Loading configuration…
      </div>
    )
  }

  if (error && !draft) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
        <button type="button" className="btn-ghost" onClick={load}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSave} className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-100">{cameraName}</h2>
          <p className="mt-0.5 text-xs text-faint">Camera {cameraId}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => handleTrigger(true)}
            disabled={!!triggering}
          >
            {triggering === 'start' ? 'Starting…' : 'Start'}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => handleTrigger(false)}
            disabled={!!triggering}
          >
            {triggering === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      </div>

      {/* ── recording mode ───────────────────────────────────────────── */}
      <section className="card p-5">
        <h3 className="text-sm font-medium text-gray-100">Recording mode</h3>
        <p className="mt-1 text-xs text-muted">
          How this camera decides when to record.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                draft.mode === m.value
                  ? 'border-accent/60 bg-elevated'
                  : 'border-border hover:bg-elevated'
              }`}
            >
              <input
                type="radio"
                name="mode"
                className="mt-0.5 accent-accent"
                checked={draft.mode === m.value}
                onChange={() => set('mode', m.value)}
              />
              <span className="min-w-0">
                <span className="block text-sm text-gray-100">{m.label}</span>
                <span className="block text-xs text-faint">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ── retention & quality ──────────────────────────────────────── */}
      <section className="card space-y-4 p-5">
        <h3 className="text-sm font-medium text-gray-100">Retention & quality</h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Retention (days)" hint="How long to keep recordings.">
            <input
              className="input"
              type="number"
              min="1"
              value={draft.retention_days}
              onChange={(e) => set('retention_days', e.target.value)}
            />
          </Field>
          <Field
            label="Recording FPS"
            hint="Frames per second to record (blank = source)."
          >
            <input
              className="input"
              type="number"
              min="1"
              placeholder="Source"
              value={draft.fps}
              onChange={(e) => set('fps', e.target.value)}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Pre-buffer (s)"
            hint="Seconds recorded before an event trigger."
          >
            <input
              className="input"
              type="number"
              min="0"
              value={draft.pre_buffer_seconds}
              onChange={(e) => set('pre_buffer_seconds', e.target.value)}
            />
          </Field>
          <Field
            label="Post-buffer (s)"
            hint="Seconds recorded after an event trigger."
          >
            <input
              className="input"
              type="number"
              min="0"
              value={draft.post_buffer_seconds}
              onChange={(e) => set('post_buffer_seconds', e.target.value)}
            />
          </Field>
        </div>
      </section>

      {/* ── options ──────────────────────────────────────────────────── */}
      <section className="card divide-y divide-border p-0">
        <Toggle
          label="Record substream"
          hint="Record the lower-bitrate substream instead of the main stream."
          checked={draft.record_substream}
          onChange={(v) => set('record_substream', v)}
        />
        <Toggle
          label="Record audio"
          hint="Capture the camera's audio track alongside video."
          checked={draft.audio_enabled}
          onChange={(v) => set('audio_enabled', v)}
        />
        <Toggle
          label="ANR (edge gap-fill)"
          hint="Backfill footage from the camera's edge storage after a network gap."
          checked={draft.anr_enabled}
          onChange={(v) => set('anr_enabled', v)}
        />
      </section>

      {notice && (
        <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setDraft(toForm(config))}
          disabled={!dirty || saving}
        >
          Reset
        </button>
        <button type="submit" className="btn-primary" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
      </div>
    </form>
  )
}

// ── small presentational helpers ───────────────────────────────────────────

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-5 py-4">
      <span className="min-w-0">
        <span className="block text-sm text-gray-100">{label}</span>
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        className="h-4 w-4 accent-accent"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}

function RecDot({ on }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${
        on ? 'bg-danger shadow-[0_0_6px] shadow-danger/70' : 'bg-faint'
      }`}
      title={on ? 'Recording' : 'Not recording'}
    />
  )
}

// ── config <-> form mapping ────────────────────────────────────────────────

function modeLabel(mode) {
  const m = MODES.find((x) => x.value === mode)
  return m ? m.label : mode || 'Unknown'
}

// toForm normalizes a server config into editable form values (numbers → strings
// so inputs stay controlled; nulls → '' for optional numeric fields).
function toForm(cfg) {
  return {
    mode: cfg.mode || 'continuous',
    retention_days: numStr(cfg.retention_days),
    fps: numStr(cfg.fps),
    pre_buffer_seconds: numStr(cfg.pre_buffer_seconds),
    post_buffer_seconds: numStr(cfg.post_buffer_seconds),
    record_substream: !!cfg.record_substream,
    audio_enabled: !!cfg.audio_enabled,
    anr_enabled: !!cfg.anr_enabled,
  }
}

// fromForm builds the PUT payload. Empty numeric fields are omitted (fps) or sent
// as their current value; blanks for optional fields become null so the server
// clears them.
function fromForm(f) {
  return {
    mode: f.mode,
    retention_days: toInt(f.retention_days),
    fps: toIntOrNull(f.fps),
    pre_buffer_seconds: toInt(f.pre_buffer_seconds),
    post_buffer_seconds: toInt(f.post_buffer_seconds),
    record_substream: !!f.record_substream,
    audio_enabled: !!f.audio_enabled,
    anr_enabled: !!f.anr_enabled,
  }
}

function numStr(v) {
  return v === null || v === undefined ? '' : String(v)
}

function toInt(v) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

function toIntOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}
