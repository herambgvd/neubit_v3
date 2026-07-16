import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import {
  estate,
  getStoredUser,
  getToken,
  setSession,
  clearSession,
} from './api.js'

// AuthContext exposes the local node session ({token,user}) plus login()/logout().
// The session is persisted in localStorage (via api.js) so a page reload keeps the
// operator signed in; state here mirrors it for reactive rendering.
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser())
  const [token, setToken] = useState(() => getToken())

  // login authenticates local credentials against the node's own auth endpoint and
  // persists the returned session bearer + user. Throws ApiError on bad creds so
  // the form can render the message.
  const login = useCallback(async (username, password) => {
    const res = await estate.post('/auth/login', { username, password }, { auth: false })
    setSession(res.token, res.user)
    setToken(res.token)
    setUser(res.user)
    return res.user
  }, [])

  // logout revokes the session on the node (best-effort) and clears local state.
  const logout = useCallback(async () => {
    try {
      await estate.post('/auth/logout', {})
    } catch {
      /* revoke is best-effort — always clear locally */
    }
    clearSession()
    setToken('')
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, token, isAuthenticated: !!token, login, logout }),
    [user, token, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
