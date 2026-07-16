import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { estate } from '../lib/api.js'

// Live is the node-served live-view screen. It lists this node's cameras, lets the
// operator pick one or more, and plays each via WebRTC/WHEP in a 1-up or 2×2 grid.
//
// Playback path (all same-origin, so it works with the central plane offline):
//   1. POST /estate/cameras/{id}/live → { webrtc_url, ... }. The node mints its own
//      media token and returns a browser-facing WHEP URL with ?token=<t> appended.
//   2. A minimal WHEP client (RTCPeerConnection + POST the SDP offer to that URL,
//      apply the SDP answer) attaches the remote track to a <video>.
//
// The grid holds up to 4 tiles; picking a 5th evicts the oldest so the layout never
// exceeds the 2×2 the box-served console is scoped to.
const MAX_TILES = 4

export default function Live() {
  const [cameras, setCameras] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // selected = ordered list of camera ids currently mounted in the grid.
  const [selected, setSelected] = useState([])

  // Load the node's cameras once. Enabled cameras sort first, then by display order
  // then name, so the most likely picks sit at the top of the rail.
  useEffect(() => {
    let alive = true
    setLoading(true)
    estate
      .get('/cameras')
      .then((res) => {
        if (!alive) return
        const items = (res && res.items) || []
        items.sort(
          (a, b) =>
            Number(b.is_enabled) - Number(a.is_enabled) ||
            (a.display_order ?? 0) - (b.display_order ?? 0) ||
            String(a.name).localeCompare(String(b.name)),
        )
        setCameras(items)
      })
      .catch((e) => alive && setError(e?.message || 'Failed to load cameras'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  // toggle adds/removes a camera from the grid. Adding a 5th tile evicts the oldest
  // so we stay within the 2×2 cap.
  const toggle = useCallback((id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      const next = [...prev, id]
      return next.length > MAX_TILES ? next.slice(next.length - MAX_TILES) : next
    })
  }, [])

  const clearAll = useCallback(() => setSelected([]), [])

  const camById = useMemo(() => {
    const m = new Map()
    for (const c of cameras) m.set(c.id, c)
    return m
  }, [cameras])

  // Grid columns: 1 tile → single, 2+ → 2 columns (2×2).
  const gridCols = selected.length <= 1 ? 'grid-cols-1' : 'grid-cols-2'

  return (
    <div className="flex h-full min-h-0">
      {/* Camera rail */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-gray-100">Cameras</span>
          {selected.length > 0 && (
            <button
              className="text-xs text-faint hover:text-gray-300"
              onClick={clearAll}
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="px-2 py-3 text-sm text-faint">Loading cameras…</div>
          )}
          {!loading && error && (
            <div className="m-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </div>
          )}
          {!loading && !error && cameras.length === 0 && (
            <div className="px-2 py-3 text-sm text-faint">
              No cameras on this node yet.
            </div>
          )}
          {cameras.map((c) => (
            <CameraRow
              key={c.id}
              camera={c}
              active={selectedSet.has(c.id)}
              onClick={() => toggle(c.id)}
            />
          ))}
        </div>
        <div className="border-t border-border p-3 text-xs text-faint">
          {selected.length}/{MAX_TILES} in view · WebRTC live
        </div>
      </aside>

      {/* Video grid */}
      <div className="min-w-0 flex-1 overflow-hidden p-4">
        {selected.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-muted">Select a camera to start live view.</p>
              <p className="mt-1 text-xs text-faint">
                Up to {MAX_TILES} streams · 2×2 grid
              </p>
            </div>
          </div>
        ) : (
          <div className={`grid h-full gap-3 ${gridCols}`}>
            {selected.map((id) => {
              const cam = camById.get(id)
              return (
                <LiveTile
                  key={id}
                  cameraId={id}
                  name={cam ? cam.name : id}
                  onClose={() => toggle(id)}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// CameraRow is one selectable camera in the left rail: a status dot (enabled/online
// vs offline), the name, and its live codec/status hint.
function CameraRow({ camera, active, onClick }) {
  const online = camera.status === 'online' || camera.status === 'streaming'
  const dot = !camera.is_enabled
    ? 'bg-faint'
    : online
      ? 'bg-ok'
      : 'bg-warn'
  return (
    <button
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        active
          ? 'bg-elevated text-white ring-1 ring-accent/50'
          : 'text-muted hover:bg-elevated hover:text-gray-200'
      }`}
    >
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 truncate">{camera.name}</span>
      {active && <span className="text-[10px] uppercase text-accent">live</span>}
    </button>
  )
}

// LiveTile renders one video with an overlaid title bar + close button and manages
// the WHEP connection lifecycle for its camera.
function LiveTile({ cameraId, name, onClose }) {
  const videoRef = useRef(null)
  const [status, setStatus] = useState('connecting') // connecting | live | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    let session = null

    async function connect() {
      setStatus('connecting')
      setMessage('')
      try {
        // 1. Ask the node for a WHEP URL (token already appended by the server).
        const live = await estate.post(`/cameras/${cameraId}/live`, {})
        if (cancelled) return
        const whepUrl = live && live.webrtc_url
        if (!whepUrl) throw new Error('no WebRTC endpoint returned')

        // 2. Negotiate the WHEP session and attach the remote stream.
        session = await playWhep(whepUrl, videoRef.current, {
          onConnected: () => !cancelled && setStatus('live'),
          onDisconnected: () => {
            if (!cancelled) {
              setStatus('error')
              setMessage('stream disconnected')
            }
          },
        })
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setMessage(e?.message || 'failed to start stream')
        }
      }
    }

    connect()
    return () => {
      cancelled = true
      if (session) session.close()
    }
  }, [cameraId])

  return (
    <div className="group relative min-h-0 overflow-hidden rounded-lg border border-border bg-black">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        autoPlay
        muted
        playsInline
      />

      {/* connecting / error overlay */}
      {status !== 'live' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          {status === 'connecting' ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-faint border-t-accent" />
              Connecting…
            </div>
          ) : (
            <div className="px-4 text-center text-sm text-danger">{message}</div>
          )}
        </div>
      )}

      {/* top gradient bar: name + live badge + close */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
              status === 'live' ? 'bg-ok' : status === 'error' ? 'bg-danger' : 'bg-warn'
            }`}
          />
          <span className="truncate text-xs font-medium text-gray-100">{name}</span>
        </div>
        <button
          onClick={onClose}
          className="pointer-events-auto rounded p-0.5 text-gray-300 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
          aria-label="Close stream"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// playWhep runs a minimal WHEP (WebRTC-HTTP Egress Protocol) handshake: create a
// recvonly RTCPeerConnection, POST the SDP offer to the WHEP URL as application/sdp,
// and apply the returned SDP answer. The remote track is attached to `videoEl`.
//
// Returns a handle with close() that tears down the peer connection. Connection
// state transitions drive the onConnected / onDisconnected callbacks.
async function playWhep(url, videoEl, { onConnected, onDisconnected } = {}) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  let closed = false

  // recvonly transceivers — we only consume media from the node.
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  const remote = new MediaStream()
  pc.ontrack = (ev) => {
    remote.addTrack(ev.track)
    if (videoEl && videoEl.srcObject !== remote) {
      videoEl.srcObject = remote
    }
  }

  pc.onconnectionstatechange = () => {
    if (closed) return
    const s = pc.connectionState
    if (s === 'connected') {
      onConnected && onConnected()
    } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      onDisconnected && onDisconnected()
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  // Wait for ICE gathering to complete so the offer we POST is non-trickle (WHEP is
  // a single request/response — no place to trickle candidates to).
  await waitIceGatheringComplete(pc)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  })
  if (!res.ok) {
    pc.close()
    throw new Error(`WHEP negotiation failed (${res.status})`)
  }

  const answer = await res.text()
  await pc.setRemoteDescription({ type: 'answer', sdp: answer })

  return {
    close() {
      closed = true
      try {
        pc.ontrack = null
        pc.onconnectionstatechange = null
        pc.close()
      } catch {
        /* already torn down */
      }
      if (videoEl) videoEl.srcObject = null
    },
  }
}

// waitIceGatheringComplete resolves once ICE gathering finishes (or immediately if
// it already has), with a short timeout so a stalled gather can't hang the tile.
function waitIceGatheringComplete(pc, timeoutMs = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      clearTimeout(timer)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, timeoutMs)
    pc.addEventListener('icegatheringstatechange', check)
  })
}
