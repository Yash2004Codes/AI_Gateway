import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';

interface ProviderHealth {
  name: string;
  display_name: string;
  health_status: 'healthy' | 'degraded' | 'down';
  error_rate: number;
  avg_latency_ms: number;
}

interface QueueMetrics {
  lanes: number;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

interface JobUpdate {
  requestId: string | null;
  tenantId: string;
  tenantName?: string;
  providersTried?: string[];
  status: string;
  provider?: string;
  model?: string;
  totalTokens?: number;
  latencyMs?: number;
  costUsd?: number;
  error?: string;
  timestamp: string;
}

interface RecentRequest {
  id: string;
  status: string;
  provider_used: string | null;
  model_used: string | null;
  total_tokens: number;
  estimated_cost_usd: number;
  total_latency_ms: number | null;
  created_at: string;
  tenant_name: string;
}

export interface ProviderControl {
  name: string;
  mode: 'live' | 'mock';
  breaker: { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'; consecutiveFailures: number; openedAt?: string; lastError?: string };
  chaos: { failureRate: number; latencyMs: number };
}

export interface TenantLive {
  id: string;
  name: string;
  tpmLimit: number;
  rpmLimit: number;
  tpmUsed: number;
  rpmUsed: number;
  rejectedLastMinute: number;
  laneDepth: number;
  inFlight: number;
  completedRecent: number;
  avgWaitMs: number | null;
  p95WaitMs: number | null;
}

export interface TrafficStatus {
  steady: boolean;
  burst: boolean;
  tenants: Record<string, { name: string; sent: number; accepted: number; rateLimited: number; errors: number }>;
}

interface SocketContextValue {
  controls: ProviderControl[];
  tenants: TenantLive[];
  fairShare: boolean;
  traffic: TrafficStatus | null;
  connected: boolean;
  providers: ProviderHealth[];
  queueMetrics: QueueMetrics;
  recentRequests: RecentRequest[];
  liveEvents: JobUpdate[];
  subscribeToTenant: (tenantId: string) => void;
}

const defaultQueue: QueueMetrics = { lanes: 0, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

const SocketContext = createContext<SocketContextValue>({
  controls: [],
  tenants: [],
  fairShare: true,
  traffic: null,
  connected: false,
  providers: [],
  queueMetrics: defaultQueue,
  recentRequests: [],
  liveEvents: [],
  subscribeToTenant: () => {},
});

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [queueMetrics, setQueueMetrics] = useState<QueueMetrics>(defaultQueue);
  const [recentRequests, setRecentRequests] = useState<RecentRequest[]>([]);
  const [liveEvents, setLiveEvents] = useState<JobUpdate[]>([]);
  const [controls, setControls] = useState<ProviderControl[]>([]);
  const [tenants, setTenants] = useState<TenantLive[]>([]);
  const [fairShare, setFairShare] = useState(true);
  const [traffic, setTraffic] = useState<TrafficStatus | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('gateway_token');
    const sock = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    sock.on('connect', () => setConnected(true));
    sock.on('disconnect', () => setConnected(false));

    sock.on('initial:state', (data: any) => {
      if (data.providers) setProviders(data.providers);
      if (data.queue) setQueueMetrics(data.queue);
      if (data.recentRequests) setRecentRequests(data.recentRequests);
    });

    sock.on('provider:health', (data: ProviderHealth) => {
      setProviders((prev) =>
        prev.map((p) => (p.name === data.name ? { ...p, ...data } : p))
      );
    });

    sock.on('metrics:update', (data: {
      queue: QueueMetrics; providers: ProviderHealth[];
      controls: ProviderControl[]; tenants: TenantLive[]; fairShare: boolean;
    }) => {
      if (data.queue) setQueueMetrics(data.queue);
      if (data.providers) setProviders(data.providers);
      if (data.controls) setControls(data.controls);
      if (data.tenants) setTenants(data.tenants);
      if (typeof data.fairShare === 'boolean') setFairShare(data.fairShare);
    });

    sock.on('demo:traffic', (data: TrafficStatus) => setTraffic(data));

    sock.on('job:update', (data: JobUpdate) => {
      setLiveEvents((prev) => [data, ...prev].slice(0, 100));
      // Update recent requests
      setRecentRequests((prev) => {
        const idx = prev.findIndex((r) => r.id === data.requestId);
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          status: data.status,
          provider_used: data.provider ?? updated[idx].provider_used,
          model_used: data.model ?? updated[idx].model_used,
          total_tokens: data.totalTokens ?? updated[idx].total_tokens,
          total_latency_ms: data.latencyMs ?? updated[idx].total_latency_ms,
        };
        return updated;
      });
    });

    setSocket(sock);
    return () => { sock.disconnect(); };
  }, []);

  const subscribeToTenant = useCallback(
    (tenantId: string) => socket?.emit('subscribe:tenant', tenantId),
    [socket]
  );

  return (
    <SocketContext.Provider value={{ controls, tenants, fairShare, traffic, connected, providers, queueMetrics, recentRequests, liveEvents, subscribeToTenant }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
