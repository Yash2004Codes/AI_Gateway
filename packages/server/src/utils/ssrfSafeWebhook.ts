import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export interface WebhookOptions {
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface WebhookResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// ─────────────────────────────────────────────────────────────
// IP Blocklist Ranges (RFC 1918, RFC 3927, Loopback, Link-Local, CGNAT, Multicast, IMDS)
// ─────────────────────────────────────────────────────────────

interface IPRangeIPv4 {
  start: number; // 32-bit unsigned int
  end: number;
}

function ipToLongIPv4(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

function parseCIDR(cidr: string): IPRangeIPv4 {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const ipLong = ipToLongIPv4(ip);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const start = (ipLong & mask) >>> 0;
  const end = (start | ~mask) >>> 0;
  return { start, end };
}

const FORBIDDEN_IPV4_RANGES: IPRangeIPv4[] = [
  parseCIDR('0.0.0.0/8'),        // Current network
  parseCIDR('10.0.0.0/8'),       // Private network (RFC 1918)
  parseCIDR('100.64.0.0/10'),    // Carrier-grade NAT
  parseCIDR('127.0.0.0/8'),      // Loopback
  parseCIDR('169.254.0.0/16'),   // Link-local / Cloud Metadata (169.254.169.254)
  parseCIDR('172.16.0.0/12'),    // Private network (RFC 1918)
  parseCIDR('192.0.0.0/24'),     // IETF Protocol Assignments
  parseCIDR('192.0.2.0/24'),     // TEST-NET-1
  parseCIDR('192.88.99.0/24'),   // 6to4 Relay Anycast
  parseCIDR('192.168.0.0/16'),   // Private network (RFC 1918)
  parseCIDR('198.18.0.0/15'),    // Benchmarking
  parseCIDR('198.51.100.0/24'),  // TEST-NET-2
  parseCIDR('203.0.113.0/24'),   // TEST-NET-3
  parseCIDR('224.0.0.0/4'),      // Multicast
  parseCIDR('240.0.0.0/4'),      // Reserved
  parseCIDR('255.255.255.255/32'),// Broadcast
];

export function isForbiddenIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  const ipLong = ipToLongIPv4(ip);
  return FORBIDDEN_IPV4_RANGES.some((range) => ipLong >= range.start && ipLong <= range.end);
}

export function isForbiddenIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;

  const normalized = ip.toLowerCase();

  // Check IPv4-mapped IPv6 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:')) {
    const parts = normalized.substring(7);
    if (net.isIPv4(parts)) {
      return isForbiddenIPv4(parts);
    }
    // Hex IPv4 mapped e.g. ::ffff:7f00:1
    const hexMatch = parts.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      const ipv4Str = `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
      return isForbiddenIPv4(ipv4Str);
    }
  }

  // Loopback (::1 / ::)
  if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Unique local IPv6 (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // Link-local IPv6 (fe80::/10)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return true;
  }

  // Multicast IPv6 (ff00::/8)
  if (normalized.startsWith('ff')) {
    return true;
  }

  return false;
}

export function isPrivateIP(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isForbiddenIPv4(ip);
  if (version === 6) return isForbiddenIPv6(ip);
  return true; // invalid IP format is treated as unsafe
}

// ─────────────────────────────────────────────────────────────
// SSRF-Safe Webhook Dispatcher with DNS Pinning
// ─────────────────────────────────────────────────────────────

export async function sendSSRFSafeWebhook(options: WebhookOptions): Promise<WebhookResponse> {
  const { url: targetUrl, method = 'POST', headers = {}, body, timeoutMs = 10000 } = options;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(`SSRF Validation Failed: Invalid URL format (${targetUrl})`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`SSRF Validation Failed: Unsupported protocol '${parsedUrl.protocol}'. Only HTTP and HTTPS allowed.`);
  }

  const hostname = parsedUrl.hostname;
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : parsedUrl.protocol === 'https:' ? 443 : 80;

  // Resolve DNS to IP addresses
  let resolvedIPs: string[] = [];

  if (net.isIP(hostname)) {
    resolvedIPs = [hostname];
  } else {
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true });
      resolvedIPs = addresses.map((a) => a.address);
    } catch (err) {
      throw new Error(`SSRF Validation Failed: DNS resolution failed for '${hostname}': ${(err as Error).message}`);
    }
  }

  if (resolvedIPs.length === 0) {
    throw new Error(`SSRF Validation Failed: No IP addresses resolved for hostname '${hostname}'`);
  }

  // Validate ALL resolved IP addresses
  for (const ip of resolvedIPs) {
    if (isPrivateIP(ip)) {
      throw new Error(`SSRF Blocked: Destination resolved to forbidden private/internal IP address (${ip}) for host '${hostname}'`);
    }
  }

  // DNS Pinning: pick the first validated IP
  const pinnedIP = resolvedIPs[0];
  const isHttps = parsedUrl.protocol === 'https:';

  const serializedBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';

  const reqHeaders: Record<string, string> = {
    'User-Agent': 'AIGateway-Webhook-Worker/1.0',
    'Host': parsedUrl.host, // Preserve Host header with port if specified
    'Content-Type': 'application/json',
    ...headers,
  };

  if (serializedBody) {
    reqHeaders['Content-Length'] = Buffer.byteLength(serializedBody).toString();
  }

  return new Promise<WebhookResponse>((resolve, reject) => {
    const requestModule = isHttps ? https : http;

    const requestOptions: http.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: pinnedIP, // DNS PINNING: Connect directly to validated IP
      port: port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: reqHeaders,
      timeout: timeoutMs,
      // Disable auto redirect following
      agent: undefined,
    };

    if (isHttps) {
      (requestOptions as https.RequestOptions).servername = hostname; // TLS SNI pinning
    }

    const req = requestModule.request(requestOptions, (res) => {
      // Reject any redirect attempt explicitly (No Redirects rule)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy();
        return reject(new Error(`SSRF Protection: HTTP Redirect (${res.statusCode}) rejected. Webhooks do not follow redirects.`));
      }

      let responseBody = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: responseBody,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`Webhook request network error: ${err.message}`));
    });

    if (serializedBody) {
      req.write(serializedBody);
    }
    req.end();
  });
}
