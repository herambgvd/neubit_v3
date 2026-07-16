import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { estate } from '../lib/api.js'

// Playback is the recorded-footage screen: pick a camera + a day, list the local
// recording segments for that window, then request a node-issued playback session
// (POST /cameras/{id}/playback) which returns a token-signed fMP4 /get URL that the
// <video> element plays. Everything is same-origin against this node's own estate
// API so it keeps working with the central control plane offline.
export default function Playback() {
  const [cameras, setCameras] = useState([])
  const [cameraId, setCameraId] = useState('')
  const [day, setDay] = useState(() => todayLocalISO())

  const [segments, setSegments] = useState([])
  const [ranges, setRanges] = useState([])
  const [playbackUrl, setPlaybackUrl] = useState('')

  const [loadingCameras, setLoadingCameras] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const videoRef = useRef(null)

  // Load the camera list once for the picker. A camera stays selected across day
  // changes; the first camera is auto-selected so the operator lands on content.
  useEffect(() => {
    let alive = true
    setLoadingCameras(true)
    estate
      .get('/cameras')
      .then((res) => {
        if (!alive) return
        const items = res?.items || []
        setCameras(items)
        setCameraId((prev) => prev || items[0]?.id || '')
      })
      .catch((err) => alive && setError(err?.message || 'Failed to load cameras'))
      .finally(() => alive && setLoadingCameras(false))
    return () => {
      alive = false
    }
  }, [])

  // dayWindow is the [from,to) UTC RFC3339 bounds of the selected local calendar
  // day — the query window for both the segment list and the playback session.
  const dayWindow = useMemo(() => dayBounds(day), [day])

  // load resolves the day's coverage: list the recording segments, then request a
  // playback session spanning the same window. An empty window is not an error —
  // the node returns 200 with no ranges + an empty playback_url ("no footage").
  const load = useCallback(async () => {
    if (!cameraId || !dayWindow) return
    setLoading(true)
    setError('')
    setNotice('')
    setSegments([])
    setRanges([])
    setPlaybackUrl('')
    try {
      const query =
        `/recordings?camera_id=${encodeURIComponent(cameraId)}` +
        `&from=${encodeURIComponent(dayWindow.from)}` +
        `&to=${encodeURIComponent(dayWindow.to)}`
      const rec = await estate.get(query)
      const segs = rec?.items || []
      setSegments(segs)

      const session = await estate.post(`/cameras/${cameraId}/playback`, {
        from: dayWindow.from,
        to: dayWindow.to,
      })
      setRanges(session?.ranges || [])
      const url = session?.playback_url || ''
      setPlaybackUrl(url)
      if (!url) {
        setNotice('No recorded footage for this camera on the selected day.')
      }
    } catch (err) {
      setError(err?.message || 'Failed to load recorded footage')
    } finally {
      setLoading(false)
    }
  }, [cameraId, dayWindow])

  // Reload coverage whenever the camera or day changes.
  useEffect(() => {
    load()
  }, [load])

  // When a playback URL arrives, (re)load the <video> so a source swap actually
  // re-buffers rather than holding the previous session's stream.
  useEffect(() => {
    const v = videoRef.current
    if (v && playbackUrl) v.load()
  }, [playbackUrl])

  const totalSeconds = useMemo(
    () => ranges.reduce((sum, r) => sum + (Number(r.duration) || 0), 0),
    [ranges],
  )

  const selectedCamera = cameras.find((c) => c.id === cameraId)

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-4 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-gray-100">Playback</h1>
          <p className="mt-0.5 text-sm text-muted">
            Recorded footage — pick a camera and day, then seek.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Camera
            </span>
            <select
              className="input min-w-[12rem]"
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              disabled={loadingCameras || cameras.length === 0}
            >
              {cameras.length === 0 && (
                <option value="">
                  {loadingCameras ? 'Loading…' : 'No cameras'}
                </option>
              )}
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.id}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">
              Day
            </span>
            <input
              type="date"
              className="input"
              value={day}
              max={todayLocalISO()}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>

          <button
            className="btn-ghost"
            onClick={load}
            disabled={loading || !cameraId}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
          {/* Player + timeline */}
          <div className="min-w-0 space-y-4">
            <div className="card overflow-hidden">
              <div className="aspect-video w-full bg-black">
                {playbackUrl ? (
                  <video
                    ref={videoRef}
                    key={playbackUrl}
                    className="h-full w-full bg-black"
                    controls
                    playsInline
                    preload="auto"
                  >
                    <source src={playbackUrl} type="video/mp4" />
                  </video>
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-faint">
                    {loading
                      ? 'Resolving recorded coverage…'
                      : notice || 'Select a camera and day to view footage.'}
                  </div>
                )}
              </div>
            </div>

            <CoverageTimeline
              ranges={ranges}
              window={dayWindow}
              onSeek={(offsetSeconds) => {
                const v = videoRef.current
                if (v && Number.isFinite(offsetSeconds)) {
                  v.currentTime = Math.max(0, offsetSeconds)
                  v.play?.().catch(() => {})
                }
              }}
            />

            <div className="flex flex-wrap gap-4 text-xs text-muted">
              <span>
                Camera:{' '}
                <span className="text-gray-200">
                  {selectedCamera?.name || cameraId || '—'}
                </span>
              </span>
              <span>
                Coverage:{' '}
                <span className="text-gray-200">
                  {ranges.length} span{ranges.length === 1 ? '' : 's'} ·{' '}
                  {formatDuration(totalSeconds)}
                </span>
              </span>
            </div>
          </div>

          {/* Segment list */}
          <div className="min-w-0">
            <div className="card flex h-full flex-col">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-medium text-gray-100">Segments</h2>
                <p className="mt-0.5 text-xs text-faint">
                  {segments.length} recorded segment
                  {segments.length === 1 ? '' : 's'} this day
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {segments.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-faint">
                    {loading ? 'Loading…' : 'No segments'}
                  </div>
                ) : (
                  <ul className="divide-y divide-border">
                    {segments.map((s, i) => (
                      <SegmentRow
                        key={s.path || i}
                        seg={s}
                        onSelect={() => {
                          const off = offsetInWindow(s.started_at, dayWindow)
                          const v = videoRef.current
                          if (v && off != null) {
                            v.currentTime = Math.max(0, off)
                            v.play?.().catch(() => {})
                          }
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// CoverageTimeline renders the day's recorded spans as filled bars on a 24-hour
// track. Clicking anywhere on the track seeks the player to that offset within the
// playback window (which spans the whole day).
function CoverageTimeline({ ranges, window, onSeek }) {
  const trackRef = useRef(null)
  const windowStart = window ? Date.parse(window.from) : NaN
  const windowSeconds = 24 * 3600

  const bars = useMemo(() => {
    if (!Number.isFinite(windowStart)) return []
    return ranges
      .map((r) => {
        const start = Date.parse(r.start)
        const dur = Number(r.duration) || 0
        if (!Number.isFinite(start)) return null
        const offset = (start - windowStart) / 1000
        const leftPct = clampPct((offset / windowSeconds) * 100)
        const widthPct = clampPct((dur / windowSeconds) * 100)
        return { leftPct, widthPct: Math.max(widthPct, 0.3) }
      })
      .filter(Boolean)
  }, [ranges, windowStart])

  function handleClick(e) {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = clamp01((e.clientX - rect.left) / rect.width)
    onSeek(ratio * windowSeconds)
  }

  return (
    <div>
      <div
        ref={trackRef}
        onClick={handleClick}
        className="relative h-8 w-full cursor-pointer overflow-hidden rounded-md border border-border bg-elevated"
        title="Click to seek"
      >
        {bars.map((b, i) => (
          <div
            key={i}
            className="absolute inset-y-0 bg-accent/70"
            style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint">
        {['00:00', '06:00', '12:00', '18:00', '24:00'].map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  )
}

// SegmentRow is a single recorded segment: its time range, duration, trigger, and
// a lock indicator for evidence-held footage. Clicking it seeks the player.
function SegmentRow({ seg, onSelect }) {
  return (
    <li>
      <button
        onClick={onSelect}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-elevated"
      >
        <div className="min-w-0">
          <div className="text-sm text-gray-200">
            {formatClock(seg.started_at)}
            {seg.ended_at ? ` – ${formatClock(seg.ended_at)}` : ''}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-faint">
            <span>{formatDuration(seg.duration)}</span>
            {seg.trigger_type && (
              <span className="rounded border border-border px-1 py-px uppercase tracking-wide">
                {seg.trigger_type}
              </span>
            )}
            {seg.locked && <span className="text-warning">locked</span>}
          </div>
        </div>
        {seg.file_size != null && (
          <span className="shrink-0 text-[11px] text-faint">
            {formatBytes(seg.file_size)}
          </span>
        )}
      </button>
    </li>
  )
}

/* ── time / format helpers ──────────────────────────────────────────────────── */

// todayLocalISO returns today's date as YYYY-MM-DD in the operator's local zone
// (the value shape a <input type="date"> expects).
function todayLocalISO() {
  const d = new Date()
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

// dayBounds turns a YYYY-MM-DD local day into the UTC RFC3339 [from,to) window
// covering that whole calendar day in the operator's local zone.
function dayBounds(dayISO) {
  if (!dayISO) return null
  const from = new Date(`${dayISO}T00:00:00`)
  if (Number.isNaN(from.getTime())) return null
  const to = new Date(from.getTime() + 24 * 3600 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

// offsetInWindow returns seconds from the window start to the given timestamp, or
// null when either is unparseable / out of range.
function offsetInWindow(ts, window) {
  if (!ts || !window) return null
  const t = Date.parse(ts)
  const start = Date.parse(window.from)
  if (!Number.isFinite(t) || !Number.isFinite(start)) return null
  return (t - start) / 1000
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v))
}
function clampPct(v) {
  return Math.min(100, Math.max(0, v))
}

// formatClock renders HH:MM:SS in local time; a nil/invalid value renders "—".
function formatClock(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

// formatDuration renders a seconds count as H:MM:SS / M:SS.
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

// formatBytes renders a byte count in the nearest binary unit.
function formatBytes(bytes) {
  const b = Number(bytes) || 0
  if (b < 1024) return `${b} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = b / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`
}
