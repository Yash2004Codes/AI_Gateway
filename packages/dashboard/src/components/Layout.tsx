import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';

const NAV_ITEMS = [
  {
    section: 'Monitoring',
    items: [
      { path: '/', label: 'Flight Radar', icon: <RadarIcon /> },
      { path: '/requests', label: 'Request Ledger', icon: <ListIcon /> },
      { path: '/demo', label: 'Demo Control', icon: <BoltIcon /> },
    ],
  },
  {
    section: 'Configuration',
    items: [
      { path: '/providers', label: 'Providers', icon: <CloudIcon /> },
      { path: '/tenants', label: 'Tenants', icon: <UsersIcon /> },
      { path: '/playground', label: 'Playground', icon: <PlayIcon /> },
    ],
  },
];

interface LayoutProps { children: React.ReactNode; }

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();
  const { connected } = useSocket();
  const navigate = useNavigate();

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="app-layout">
      {/* ── Sidebar ───────────────────────────── */}
      <aside className="app-sidebar">
        {/* Logo */}
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </div>
          <div className="sidebar-logo-text">
            <span className="sidebar-logo-title">AI Gateway</span>
            <span className="sidebar-logo-subtitle">Flight Radar v1.0</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((section) => (
            <div key={section.section}>
              <div className="sidebar-section-label">{section.section}</div>
              {section.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
                  id={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <span className="nav-icon">{item.icon}</span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="sidebar-footer">
          {/* Connection status */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', padding: '0.5rem 0' }}>
            <div className="conn-status">
              <div className={`conn-dot ${connected ? '' : 'disconnected'}`} />
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                {connected ? 'Live connected' : 'Disconnected'}
              </span>
            </div>
          </div>

          {/* User */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', padding: '0.5rem 0' }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--gradient-brand)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', fontWeight: 700, flexShrink: 0,
            }}>
              {user?.name?.charAt(0)?.toUpperCase() ?? 'A'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {user?.name}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>{user?.role}</div>
            </div>
            <button
              id="logout-btn"
              className="btn btn-secondary btn-sm btn-icon"
              onClick={handleLogout}
              title="Logout"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main Content ──────────────────────── */}
      <main className="app-main">
        <header className="app-topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
              Enterprise LLM Traffic Management
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div className="conn-status">
              <div className={`conn-dot ${connected ? '' : 'disconnected'}`} />
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                {connected ? 'Real-time' : 'Polling'}
              </span>
            </div>
            <div style={{ height: '20px', width: '1px', background: 'var(--color-border)' }} />
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {new Date().toLocaleTimeString()}
            </div>
          </div>
        </header>
        <div className="app-content">
          {children}
        </div>
      </main>
    </div>
  );
}

/* ── SVG Icons ────────────────────────────────────────── */
function RadarIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>;
}
function ListIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
}
function CloudIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
}
function UsersIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>;
}
function BoltIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>;
}
