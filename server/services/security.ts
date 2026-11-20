import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import AdmZip from 'adm-zip';

const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me-in-production-use-64-char-random-hex'
    ? process.env.JWT_SECRET
    : crypto.createHash('sha256').update(`autopatch-dev-secret-${process.cwd()}`).digest('hex');

export interface AuthTokenPayload {
  userId: string;
  email: string;
  name: string;
  role: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to a private, loopback,
 * link-local, carrier-grade NAT, unspecified, or cloud-metadata range.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIp(mapped);
    }
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // multicast & reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true; // link-local fe80::/10
    }
    if (normalized.startsWith('ff')) return true; // multicast
    return false;
  }

  return true;
}

export interface UrlValidationResult {
  safe: boolean;
  reason?: string;
  normalizedUrl?: string;
  resolvedIps?: string[];
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

export function validateUrlSyntax(rawUrl: string): { valid: boolean; url?: URL; reason?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, reason: 'URL is required.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'Invalid URL format. Include http:// or https://.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: `Protocol "${parsed.protocol}" is blocked. Only http: and https: are permitted.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Credentials in URLs are prohibited for security reasons.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { valid: false, reason: 'URL hostname is missing.' };
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    return { valid: false, reason: `SSRF protection blocked internal hostname "${hostname}".` };
  }

  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    return { valid: false, reason: `SSRF protection blocked private or loopback IP "${hostname}".` };
  }

  return { valid: true, url: parsed };
}

export async function validateSafeExternalUrl(rawUrl: string): Promise<UrlValidationResult> {
  const syntax = validateUrlSyntax(rawUrl);
  if (!syntax.valid || !syntax.url) {
    return { safe: false, reason: syntax.reason };
  }

  const hostname = syntax.url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { safe: false, reason: `SSRF protection blocked private IP "${hostname}".` };
    }
    return { safe: true, normalizedUrl: syntax.url.toString(), resolvedIps: [hostname] };
  }

  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    if (!records.length) {
      return { safe: false, reason: `DNS resolution failed for "${hostname}".` };
    }
    const ips = records.map((r) => r.address);
    for (const ip of ips) {
      if (isPrivateOrReservedIp(ip)) {
        return {
          safe: false,
          reason: `SSRF protection blocked "${hostname}" because DNS resolved to private IP ${ip}.`,
        };
      }
    }
    return { safe: true, normalizedUrl: syntax.url.toString(), resolvedIps: ips };
  } catch (err) {
    return {
      safe: false,
      reason: `DNS lookup error for "${hostname}": ${err instanceof Error ? err.message : 'Host unreachable'}`,
    };
  }
}

/**
 * Fetches an external URL while re-validating every redirect hop against SSRF rules,
 * enforcing timeout and response size limits.
 */
export async function safeExternalFetch(
  initialUrl: string,
  options: { method?: 'GET' | 'HEAD'; timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<{
  response: Response;
  finalUrl: string;
  redirectChain: string[];
  bodyText: string;
  loadTimeMs: number;
}> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 12000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024; // 2MB
  const maxRedirects = options.maxRedirects ?? 5;

  let currentUrl = initialUrl;
  const redirectChain: string[] = [];
  const start = Date.now();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await validateSafeExternalUrl(currentUrl);
    if (!check.safe || !check.normalizedUrl) {
      throw new Error(check.reason ?? 'Blocked by SSRF protection.');
    }
    currentUrl = check.normalizedUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'AutoPatchAI-WebsiteDebugger/1.0 (+security-scanner)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        if (hop === maxRedirects) {
          throw new Error(`Exceeded maximum redirect hops (${maxRedirects}).`);
        }
        redirectChain.push(currentUrl);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }

    let bodyText = '';
    if (method === 'GET' && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
            break;
          }
          chunks.push(value);
        }
      }
      bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    }

    return {
      response,
      finalUrl: currentUrl,
      redirectChain,
      bodyText,
      loadTimeMs: Date.now() - start,
    };
  }

  throw new Error('Failed to resolve URL after redirects.');
}

/**
 * Validates and normalizes an archive/uploaded relative file path to block path traversal.
 */
export function sanitizeArchiveEntryPath(rawEntryPath: string): { safe: boolean; normalized?: string; reason?: string } {
  if (!rawEntryPath || rawEntryPath.includes('\0')) {
    return { safe: false, reason: 'Invalid or null-byte file path.' };
  }
  const unixPath = rawEntryPath.replace(/\\/g, '/').trim();
  if (unixPath.startsWith('/') || /^[a-zA-Z]:/.test(unixPath)) {
    return { safe: false, reason: `Absolute path rejected: "${rawEntryPath}"` };
  }
  const segments = unixPath.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    return { safe: false, reason: 'Empty archive entry path.' };
  }
  if (segments.some((seg) => seg === '..')) {
    return { safe: false, reason: `Path traversal rejected: "${rawEntryPath}"` };
  }
  const normalized = path.posix.normalize(segments.join('/'));
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    return { safe: false, reason: `Unsafe normalized path: "${rawEntryPath}"` };
  }
  return { safe: true, normalized };
}

export const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.go', '.rs',
  '.sql', '.html', '.htm', '.css', '.scss', '.json', '.php', '.cs',
  '.md', '.txt', '.yml', '.yaml', '.env.example', '.xml',
]);

export interface ExtractedSourceFile {
  relativePath: string;
  content: string;
  sizeBytes: number;
}

export interface SafeZipResult {
  files: ExtractedSourceFile[];
  skipped: Array<{ path: string; reason: string }>;
  rejectedSecurityEntries: Array<{ path: string; reason: string }>;
}

const IGNORED_DIRS = ['node_modules/', '.git/', 'dist/', 'build/', '__pycache__/', '.venv/', 'venv/', '.next/', 'target/'];

export function safelyExtractZipBuffer(
  zipBuffer: Buffer,
  limits: { maxFiles?: number; maxTotalBytes?: number; maxSingleFileBytes?: number } = {},
): SafeZipResult {
  const maxFiles = limits.maxFiles ?? 250;
  const maxTotalBytes = limits.maxTotalBytes ?? 15 * 1024 * 1024; // 15MB extracted
  const maxSingleFileBytes = limits.maxSingleFileBytes ?? 1.5 * 1024 * 1024; // 1.5MB per source file

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new Error(`Invalid or corrupted ZIP archive: ${err instanceof Error ? err.message : 'Unable to parse ZIP'}`);
  }

  const entries = zip.getEntries();
  if (entries.length === 0) {
    throw new Error('ZIP archive is empty.');
  }

  const files: ExtractedSourceFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const rejectedSecurityEntries: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Reject symlinks (UNIX mode 0120000 in upper 16 bits of attr)
    const unixMode = (entry.header.attr >>> 16) & 0o170000;
    if (unixMode === 0o120000) {
      rejectedSecurityEntries.push({ path: entry.entryName, reason: 'Symbolic links are not permitted in uploads.' });
      continue;
    }

    const sanitized = sanitizeArchiveEntryPath(entry.entryName);
    if (!sanitized.safe || !sanitized.normalized) {
      rejectedSecurityEntries.push({ path: entry.entryName, reason: sanitized.reason ?? 'Unsafe path.' });
      continue;
    }

    const normalized = sanitized.normalized;
    if (normalized.startsWith('__MACOSX/') || path.posix.basename(normalized).startsWith('._')) {
      continue;
    }

    if (IGNORED_DIRS.some((dir) => normalized.includes(dir) || normalized.startsWith(dir))) {
      skipped.push({ path: normalized, reason: 'Ignored dependency or build directory.' });
      continue;
    }

    const ext = path.posix.extname(normalized).toLowerCase();
    if (!SUPPORTED_SOURCE_EXTENSIONS.has(ext)) {
      skipped.push({ path: normalized, reason: `Unsupported or binary file extension (${ext || 'none'}).` });
      continue;
    }

    if (files.length >= maxFiles) {
      skipped.push({ path: normalized, reason: `Exceeded max extractable file limit (${maxFiles}).` });
      continue;
    }

    const rawData = entry.getData();
    if (rawData.byteLength > maxSingleFileBytes) {
      skipped.push({ path: normalized, reason: `File exceeds single-file limit (${Math.round(maxSingleFileBytes / 1024)} KB).` });
      continue;
    }

    totalBytes += rawData.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Archive rejected: extracted size exceeds ${Math.round(maxTotalBytes / (1024 * 1024))} MB limit (zip-bomb protection).`);
    }

    // Check for NUL bytes indicating binary content masquerading as text
    if (rawData.subarray(0, 8192).includes(0)) {
      skipped.push({ path: normalized, reason: 'Binary content detected in source file.' });
      continue;
    }

    files.push({
      relativePath: normalized,
      content: rawData.toString('utf8'),
      sizeBytes: rawData.byteLength,
    });
  }

  return { files, skipped, rejectedSecurityEntries };
}
