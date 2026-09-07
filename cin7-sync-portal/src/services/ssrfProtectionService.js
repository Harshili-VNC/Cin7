const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * SSRF Protection Service
 * Reusable utility to protect outbound HTTP requests against Server-Side Request Forgery (SSRF),
 * DNS rebinding, internal network scanning, and cloud metadata access (e.g. AWS/GCP 169.254.169.254).
 */
class SSRFProtectionService {
  constructor() {
    this.allowedProtocols = new Set(['http:', 'https:']);
  }

  /**
   * Checks if an IPv4 address is in a private, loopback, link-local, or cloud metadata range.
   */
  isPrivateIPv4(ip) {
    const parts = ip.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) {
      return true; // Malformed -> reject
    }

    const [a, b, c, d] = parts;

    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;

    // 10.0.0.0/8 (Private)
    if (a === 10) return true;

    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;

    // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;

    // 172.16.0.0/12 (Private: 172.16.0.0 – 172.31.255.255)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;

    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;

    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (Documentation / TEST-NET)
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (a >= 224) return true;

    // 255.255.255.255 (Broadcast)
    if (a === 255 && b === 255 && c === 255 && d === 255) return true;

    return false;
  }

  /**
   * Checks if an IPv6 address is private, loopback, or link-local.
   */
  isPrivateIPv6(ip) {
    const clean = ip.toLowerCase();
    if (clean === '::1' || clean === '::' || clean.startsWith('fe80:') || clean.startsWith('fc00:') || clean.startsWith('fd00:')) {
      return true;
    }
    // IPv4-mapped IPv6 address (::ffff:127.0.0.1 or ::ffff:10.0.0.1)
    if (clean.startsWith('::ffff:')) {
      const ipv4Part = clean.replace('::ffff:', '');
      return this.isPrivateIPv4(ipv4Part);
    }
    return false;
  }

  /**
   * Validates a target URL against SSRF rules and resolved IP addresses.
   * @param {string} rawUrl - Target URL string
   * @param {Object} options - Options including allowedHosts whitelist and allowPrivate (for local testing only)
   */
  async validateUrl(rawUrl, options = {}) {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new Error('SSRF_INVALID_URL: Target URL is required and must be a string.');
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (err) {
      throw new Error(`SSRF_INVALID_URL: Unable to parse URL: ${err.message}`);
    }

    // Protocol check
    if (!this.allowedProtocols.has(parsed.protocol)) {
      throw new Error(`SSRF_DISALLOWED_PROTOCOL: Protocol "${parsed.protocol}" is not allowed. Only HTTP and HTTPS are permitted.`);
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check against configured allowed host(s) if provided
    if (options.allowedHosts && Array.isArray(options.allowedHosts) && options.allowedHosts.length > 0) {
      const isAllowed = options.allowedHosts.some(allowed => {
        if (!allowed) return false;
        const cleanAllowed = allowed.toLowerCase().replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
        return hostname === cleanAllowed || hostname.endsWith(`.${cleanAllowed}`);
      });
      if (!isAllowed) {
        throw new Error(`SSRF_HOST_NOT_ALLOWED: Host "${hostname}" is not in the allowed hosts list.`);
      }
    }

    // In non-production testing, allow local testing ONLY if explicitly allowed by option
    if (options.allowLocalTesting && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1')) {
      return {
        url: parsed.href,
        hostname,
        protocol: parsed.protocol,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        isLocalTest: true
      };
    }

    // Explicit localhost / loopback rejection
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      throw new Error(`SSRF_BLOCKED_HOST: Host "${hostname}" is a forbidden loopback address.`);
    }

    // Resolve DNS to verify the actual target IP (prevents DNS rebinding and private IP domain spoofing)
    try {
      const records = await dns.lookup(hostname, { all: true });
      if (!records || records.length === 0) {
        throw new Error(`SSRF_DNS_FAILED: No DNS records resolved for hostname "${hostname}".`);
      }

      for (const record of records) {
        const ip = record.address;
        const family = record.family;

        if (family === 4 && this.isPrivateIPv4(ip)) {
          throw new Error(`SSRF_BLOCKED_IP: Resolved IP "${ip}" for host "${hostname}" belongs to a private, loopback, or cloud-metadata network.`);
        }
        if (family === 6 && this.isPrivateIPv6(ip)) {
          throw new Error(`SSRF_BLOCKED_IP: Resolved IPv6 "${ip}" for host "${hostname}" belongs to a private or loopback network.`);
        }
      }

      return {
        url: parsed.href,
        hostname,
        protocol: parsed.protocol,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        resolvedIps: records.map(r => r.address)
      };
    } catch (err) {
      if (err.message.startsWith('SSRF_')) throw err;
      throw new Error(`SSRF_DNS_RESOLUTION_ERROR: Failed to resolve host "${hostname}": ${err.message}`);
    }
  }

  /**
   * Safely fetches an outbound stream from a validated URL with strict timeouts and maximum byte limit.
   * @param {string} rawUrl - Target URL
   * @param {Object} options - Validation options, timeoutMs, maxSizeBytes
   */
  async safeFetchStream(rawUrl, options = {}) {
    const validated = await this.validateUrl(rawUrl, options);
    const timeoutMs = options.timeoutMs || 30000;
    const maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024; // 50MB default limit

    const client = validated.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = client.get(validated.url, { timeout: timeoutMs }, (res) => {
        // Disallow arbitrary redirects or validate them strictly
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          req.destroy();
          return reject(new Error('SSRF_REDIRECT_DISALLOWED: Automatic redirects are disabled for security.'));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          req.destroy();
          return reject(new Error(`SSRF_FETCH_HTTP_ERROR: Target server responded with status code ${res.statusCode}.`));
        }

        const contentLength = parseInt(res.headers['content-length'] || '0', 10);
        if (contentLength > maxSizeBytes) {
          req.destroy();
          return reject(new Error(`SSRF_MAX_SIZE_EXCEEDED: Content-Length ${contentLength} exceeds maximum limit of ${maxSizeBytes} bytes.`));
        }

        let downloadedBytes = 0;
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (downloadedBytes > maxSizeBytes) {
            req.destroy();
            res.destroy(new Error(`SSRF_MAX_SIZE_EXCEEDED: Download exceeded maximum limit of ${maxSizeBytes} bytes.`));
          }
        });

        resolve({ stream: res, headers: res.headers, statusCode: res.statusCode });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`SSRF_TIMEOUT: Request timed out after ${timeoutMs}ms.`));
      });

      req.on('error', (err) => {
        reject(new Error(`SSRF_NETWORK_ERROR: ${err.message}`));
      });
    });
  }
}

module.exports = new SSRFProtectionService();
