import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth.jsx'
import AppShell from './components/AppShell.jsx'

import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Channels from './pages/Channels.jsx'
import Recording from './pages/Recording.jsx'
import Storage from './pages/Storage.jsx'
import Live from './pages/Live.jsx'
import Playback from './pages/Playback.jsx'
import Users from './pages/Users.jsx'
import Logs from './pages/Logs.jsx'

// ProtectedRoute gates the authenticated app: an unauthenticated visitor is sent to
// /login, preserving the attempted path so a post-login redirect can restore it.
function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()
  const location = useLocation()
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/channels" element={<Channels />} />
        <Route path="/recording" element={<Recording />} />
        <Route path="/storage" element={<Storage />} />
        <Route path="/live" element={<Live />} />
        <Route path="/playback" element={<Playback />} />
        <Route path="/users" element={<Users />} />
        <Route path="/logs" element={<Logs />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
