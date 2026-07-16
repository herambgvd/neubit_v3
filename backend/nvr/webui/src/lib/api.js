// Tiny fetch-based API client for the box-served node console. It talks ONLY to
// this node's own API at the same origin (/api/v1/nvr), so it keeps working with
// the central control plane offline. The bearer is the node-issued local session
// token (POST /estate/auth/login); it is attached to every /estate/* call.
//
// On a 401 the client clears the stored session and hard-redirects to /login so a
// stale/expired session never leaves the operator on a broken screen.

const API_BASE = '/api/v1/nvr'
const TOKEN_KEY = 'nvr.node.token'
const USER_KEY = 'nvr.node.user'

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setSession(token, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token || '')
    localStorage.setItem(USER_KEY, JSON.stringify(user || null))
  } catch {
    /* storage unavailable — session lives only in memory for this tab */
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    /* ignore */
  }
}

// ApiError carries the HTTP status + parsed kernel error body so callers can
// branch on status (e.g. 401 handled centrally) and surface a friendly message.
export class ApiError extends Error {
  constructor(status, body) {
    const msg =
      (body && (body.message || body.detail || body.error)) ||
      `request failed (${status})`
    super(msg)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

// request is the core fetch wrapper: prefixes the API base, attaches the bearer,
// JSON-encodes a body, and normalizes the response. A 401 clears the session and
// redirects to /login (unless it is the login call itself, which reports the 401
// to the form). 204/empty bodies resolve to null.
async function request(method, path, { body, auth = true, raw = false } = {}) {
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }

  let res
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new ApiError(0, { message: 'network error — node unreachable' })
  }

  if (res.status === 401 && auth) {
    clearSession()
    if (window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
    throw new ApiError(401, await safeJson(res))
  }

  if (raw) {
    if (!res.ok) throw new ApiError(res.status, await safeJson(res))
    return res
  }

  const data = res.status === 204 ? null : await safeJson(res)
  if (!res.ok) throw new ApiError(res.status, data)
  return data
}

async function safeJson(res) {
  try {
    const text = await res.text()
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

// Public verb helpers. estate-scoped paths are relative to /estate for brevity.
export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  put: (path, body, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  del: (path, opts) => request('DELETE', path, opts),
  raw: (method, path, opts) => request(method, path, { ...opts, raw: true }),
}

// estate() prefixes /estate for the node-authoritative management API so pages can
// call estate.get('/cameras') etc.
export const estate = {
  get: (path, opts) => api.get('/estate' + path, opts),
  post: (path, body, opts) => api.post('/estate' + path, body, opts),
  put: (path, body, opts) => api.put('/estate' + path, body, opts),
  patch: (path, body, opts) => api.patch('/estate' + path, body, opts),
  del: (path, opts) => api.del('/estate' + path, opts),
}
