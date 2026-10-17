import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import RequestsPage from './pages/RequestsPage';
import ProvidersPage from './pages/ProvidersPage';
import TenantsPage from './pages/TenantsPage';
import PlaygroundPage from './pages/PlaygroundPage';
import DemoPage from './pages/DemoPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--color-text-muted)' }}>
        <div className="spinner" style={{ width: 28, height: 28 }} />
        <span>Authenticating…</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <SocketProvider>
              <Layout>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/requests" element={<RequestsPage />} />
                  <Route path="/providers" element={<ProvidersPage />} />
                  <Route path="/tenants" element={<TenantsPage />} />
                  <Route path="/playground" element={<PlaygroundPage />} />
                  <Route path="/demo" element={<DemoPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </SocketProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
