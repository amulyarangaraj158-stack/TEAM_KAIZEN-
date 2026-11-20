import * as cheerio from 'cheerio';
import * as esbuild from 'esbuild';
import { safeExternalFetch, validateSafeExternalUrl } from './security';

export interface WebsiteIssue {
  id: string;
  checkCategory: string;
  name: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  affectedUrl: string;
  evidence: string;
  suggestedSolution: string;
  matchedProjectFile?: string | null;
}

export interface WebsiteScanMetrics {
  httpStatus: number;
  loadTimeMs: number;
  htmlSizeBytes: number;
  linksChecked: number;
  brokenLinksCount: number;
  imagesChecked: number;
  brokenImagesCount: number;
  scriptsFound: number;
  inlineScriptErrors: number;
  accessibilityIssues: number;
  seoIssues: number;
  performanceIssues: number;
  responsiveIssues: number;
  redirectCount: number;
}

export interface WebsiteScanReport {
  url: string;
  finalUrl: string;
  status: 'completed' | 'failed';
  httpStatus: number;
  loadTimeMs: number;
  issues: WebsiteIssue[];
  metrics: WebsiteScanMetrics;
  summary: {
    totalIssues: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    score: number;
    isExternalOnly: boolean;
    sourceAccessNote: string;
  };
}

export async function runWebsiteDebuggerScan(
  targetUrl: string,
  options: {
    onProgress?: (stage: string, detail: string) => void;
    projectFiles?: Array<{ relativePath: string; content: string }>;
  } = {},
): Promise<WebsiteScanReport> {
  const emit = options.onProgress ?? (() => {});
  const issues: WebsiteIssue[] = [];
  let issueIdx = 1;
  const addIssue = (item: Omit<WebsiteIssue, 'id'>) => {
    issues.push({ id: `web-${issueIdx++}`, ...item });
  };

  emit('SSRF & DNS Validation', `Validating protocol, hostname, and DNS records for ${targetUrl}`);
  const preCheck = await validateSafeExternalUrl(targetUrl);
  if (!preCheck.safe) {
    throw new Error(preCheck.reason ?? 'Target URL rejected by SSRF protection.');
  }

  emit('HTTP Fetch & Redirect Verification', `Requesting ${preCheck.normalizedUrl} with redirect revalidation`);
  const fetched = await safeExternalFetch(preCheck.normalizedUrl!, {
    method: 'GET',
    timeoutMs: 12000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
  });

  const { response, finalUrl, redirectChain, bodyText, loadTimeMs } = fetched;
  const httpStatus = response.status;
  const htmlSizeBytes = Buffer.byteLength(bodyText, 'utf8');
  const contentType = response.headers.get('content-type') ?? '';

  // 1. HTTP response problems
  if (httpStatus >= 400) {
    addIssue({
      checkCategory: 'HTTP Response',
      name: `HTTP ${httpStatus} error response`,
      description: `The target URL returned HTTP status ${httpStatus} (${response.statusText || 'Error'}).`,
      severity: httpStatus >= 500 ? 'critical' : 'high',
      affectedUrl: finalUrl,
      evidence: `Status: ${httpStatus} ${response.statusText}; Content-Type: ${contentType || 'none'}`,
      suggestedSolution: 'Verify server routing, upstream availability, and error-handling middleware for this route.',
    });
  }

  if (redirectChain.length >= 2) {
    addIssue({
      checkCategory: 'HTTP Response',
      name: 'Multi-hop redirect chain detected',
      description: `Page redirected ${redirectChain.length} times before landing on ${finalUrl}.`,
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: `Redirect chain: ${redirectChain.join(' -> ')} -> ${finalUrl}`,
      suggestedSolution: 'Update internal links and canonical URLs to point directly to the final destination.',
    });
  }

  // Security headers check
  if (finalUrl.startsWith('https://') && !response.headers.get('strict-transport-security')) {
    addIssue({
      checkCategory: 'HTTP Response',
      name: 'Missing Strict-Transport-Security (HSTS) header',
      description: 'HTTPS endpoint does not advertise HSTS policy.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: 'Response header "strict-transport-security" was absent.',
      suggestedSolution: 'Add "Strict-Transport-Security: max-age=31536000; includeSubDomains" in server or CDN headers.',
    });
  }

  if (!response.headers.get('x-content-type-options')) {
    addIssue({
      checkCategory: 'HTTP Response',
      name: 'Missing X-Content-Type-Options header',
      description: 'Server does not send X-Content-Type-Options: nosniff.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: 'Response header "x-content-type-options" was absent.',
      suggestedSolution: 'Send "X-Content-Type-Options: nosniff" to prevent MIME-sniffing vulnerabilities.',
    });
  }

  emit('DOM, SEO & Accessibility Inspection', 'Parsing HTML document structure, metadata, and accessibility tree');
  const $ = cheerio.load(bodyText);

  let accessibilityIssues = 0;
  let seoIssues = 0;
  let performanceIssues = 0;
  let responsiveIssues = 0;
  let inlineScriptErrors = 0;

  // 2. SEO checks
  const titleText = $('title').first().text().trim();
  if (!titleText) {
    seoIssues++;
    addIssue({
      checkCategory: 'SEO',
      name: 'Missing <title> tag',
      description: 'Document has no <title> element or it is empty.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: '<head> contains no non-empty <title> element.',
      suggestedSolution: 'Add a unique, descriptive <title> (30-60 characters) inside <head>.',
    });
  }
  const metaDesc = $('meta[name="description"]').attr('content')?.trim();
  if (!metaDesc) {
    seoIssues++;
    addIssue({
      checkCategory: 'SEO',
      name: 'Missing meta description',
      description: 'Page does not include a <meta name="description"> tag.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: 'No <meta name="description"> tag found in document head.',
      suggestedSolution: 'Add <meta name="description" content="..."> summarizing page intent in 120-160 characters.',
    });
  }
  const h1Count = $('h1').length;
  if (h1Count === 0) {
    seoIssues++;
    addIssue({
      checkCategory: 'SEO',
      name: 'Missing primary <h1> heading',
      description: 'Document does not contain an <h1> heading.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: '0 <h1> elements found in DOM.',
      suggestedSolution: 'Include a single semantic <h1> element describing the main page subject.',
    });
  } else if (h1Count > 1) {
    seoIssues++;
    addIssue({
      checkCategory: 'SEO',
      name: `Multiple <h1> headings (${h1Count})`,
      description: 'Document defines multiple top-level <h1> headings.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: `Found ${h1Count} <h1> elements.`,
      suggestedSolution: 'Use one primary <h1> and demote secondary section titles to <h2> or <h3>.',
    });
  }

  // 3. Responsive layout checks
  const viewportMeta = $('meta[name="viewport"]').attr('content');
  if (!viewportMeta) {
    responsiveIssues++;
    addIssue({
      checkCategory: 'Responsive Layout',
      name: 'Missing responsive viewport meta tag',
      description: 'Page lacks <meta name="viewport" content="width=device-width, initial-scale=1">.',
      severity: 'high',
      affectedUrl: finalUrl,
      evidence: 'No <meta name="viewport"> tag in <head>.',
      suggestedSolution: 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0" /> to <head>.',
    });
  } else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewportMeta)) {
    responsiveIssues++;
    accessibilityIssues++;
    addIssue({
      checkCategory: 'Responsive Layout',
      name: 'Viewport disables user pinch-to-zoom',
      description: 'Viewport meta restricts scaling, hurting mobile accessibility.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `meta[name="viewport"] content="${viewportMeta}"`,
      suggestedSolution: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
    });
  }

  const wideInlineElements = $('[style*="width:"]').filter((_, el) => {
    const style = $(el).attr('style') ?? '';
    const match = style.match(/width\s*:\s*(\d+)px/i);
    return Boolean(match && Number(match[1]) > 768);
  });
  if (wideInlineElements.length > 0) {
    responsiveIssues++;
    addIssue({
      checkCategory: 'Responsive Layout',
      name: 'Fixed pixel width exceeds mobile viewport',
      description: `${wideInlineElements.length} element(s) declare fixed inline widths > 768px.`,
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `Example inline style: ${(wideInlineElements.first().attr('style') ?? '').slice(0, 120)}`,
      suggestedSolution: 'Replace fixed pixel widths with max-width: 100% or responsive CSS Grid/Flexbox units.',
    });
  }

  // 4. Accessibility checks
  const htmlLang = $('html').attr('lang')?.trim();
  if (!htmlLang) {
    accessibilityIssues++;
    addIssue({
      checkCategory: 'Accessibility',
      name: 'Missing lang attribute on <html>',
      description: 'Root <html> element does not specify a language.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: '<html> tag has no lang attribute.',
      suggestedSolution: 'Add lang="en" (or appropriate BCP 47 language code) to the <html> tag.',
    });
  }

  const imgsMissingAlt: string[] = [];
  $('img').each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined) {
      imgsMissingAlt.push($(el).attr('src') || '<img without src>');
    }
  });
  if (imgsMissingAlt.length > 0) {
    accessibilityIssues++;
    addIssue({
      checkCategory: 'Accessibility',
      name: `${imgsMissingAlt.length} image(s) missing alt attribute`,
      description: 'Images without alt attributes are inaccessible to assistive technologies.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `Examples: ${imgsMissingAlt.slice(0, 3).join(', ')}`,
      suggestedSolution: 'Add descriptive alt="..." attributes to meaningful images or alt="" for decorative images.',
    });
  }

  let unlabeledInputs = 0;
  $('input, select, textarea').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(type)) return;
    const id = $(el).attr('id');
    const ariaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby');
    const hasForLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
    const insideLabel = $(el).closest('label').length > 0;
    if (!ariaLabel && !hasForLabel && !insideLabel) {
      unlabeledInputs++;
    }
  });
  if (unlabeledInputs > 0) {
    accessibilityIssues++;
    addIssue({
      checkCategory: 'Accessibility',
      name: `${unlabeledInputs} form input(s) missing accessible labels`,
      description: 'Interactive form controls have no associated <label> or aria-label.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `${unlabeledInputs} input/select/textarea element(s) lack label bindings.`,
      suggestedSolution: 'Bind each input with <label htmlFor="..."> or provide a descriptive aria-label.',
    });
  }

  // 5. Frontend rendering issues (duplicate IDs, mixed content, deprecated tags)
  const idCounts = new Map<string, number>();
  $('[id]').each((_, el) => {
    const id = $(el).attr('id');
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  });
  const dupIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (dupIds.length > 0) {
    addIssue({
      checkCategory: 'Frontend Rendering',
      name: `Duplicate DOM id attributes (${dupIds.length})`,
      description: 'Multiple elements share identical id attributes, breaking label associations and DOM queries.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `Duplicate IDs: ${dupIds.slice(0, 5).join(', ')}`,
      suggestedSolution: 'Ensure every id attribute in the rendered HTML document is unique.',
    });
  }

  if (finalUrl.startsWith('https://')) {
    const mixedResources: string[] = [];
    $('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]').each((_, el) => {
      mixedResources.push($(el).attr('src') || $(el).attr('href') || '');
    });
    if (mixedResources.length > 0) {
      addIssue({
        checkCategory: 'Frontend Rendering',
        name: 'Mixed HTTP content on HTTPS page',
        description: `${mixedResources.length} subresource(s) load over insecure http:// on an https:// page.`,
        severity: 'high',
        affectedUrl: finalUrl,
        evidence: `Resources: ${mixedResources.slice(0, 3).join(', ')}`,
        suggestedSolution: 'Upgrade all embedded resource URLs to https:// so browsers do not block active content.',
      });
    }
  }

  // 6. Performance checks
  if (loadTimeMs > 2500) {
    performanceIssues++;
    addIssue({
      checkCategory: 'Performance',
      name: `Slow initial HTML response (${loadTimeMs}ms)`,
      description: 'Document fetch exceeded 2500ms threshold.',
      severity: loadTimeMs > 5000 ? 'high' : 'medium',
      affectedUrl: finalUrl,
      evidence: `Measured TTFB/HTML fetch time: ${loadTimeMs}ms`,
      suggestedSolution: 'Enable edge caching, optimize backend queries, and compress responses with Brotli/Gzip.',
    });
  }

  const blockingScripts = $('head script[src]:not([async]):not([defer]):not([type="module"])').length;
  if (blockingScripts > 0) {
    performanceIssues++;
    addIssue({
      checkCategory: 'Performance',
      name: `${blockingScripts} render-blocking script(s) in <head>`,
      description: 'Synchronous <script src> tags in <head> block initial HTML parsing and First Contentful Paint.',
      severity: 'medium',
      affectedUrl: finalUrl,
      evidence: `Detected ${blockingScripts} blocking <script> tag(s) in <head>.`,
      suggestedSolution: 'Add defer or async attributes (or type="module") to non-critical scripts.',
    });
  }

  if (htmlSizeBytes > 350 * 1024) {
    performanceIssues++;
    addIssue({
      checkCategory: 'Performance',
      name: `Large HTML payload (${Math.round(htmlSizeBytes / 1024)} KB)`,
      description: 'HTML document size is large and may delay parsing on slower devices.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: `Document bytes: ${htmlSizeBytes.toLocaleString()} bytes`,
      suggestedSolution: 'Remove inline base64 blobs, minify HTML, and defer non-critical DOM trees.',
    });
  }

  // 7. JavaScript runtime & console static syntax checks on inline scripts
  emit('JavaScript & Console Diagnostics', 'Inspecting inline JavaScript blocks for syntax and runtime errors');
  const scriptTags = $('script');
  scriptTags.each((idx, el) => {
    const src = $(el).attr('src');
    const type = ($(el).attr('type') || '').toLowerCase();
    if (src || (type && !type.includes('javascript') && type !== 'module')) return;
    const code = $(el).html() || '';
    if (!code.trim()) return;
    try {
      esbuild.transformSync(code, { loader: 'js', target: 'es2022' });
    } catch (err: unknown) {
      inlineScriptErrors++;
      const buildErr = err as { errors?: Array<{ text: string; location?: { line: number } }> };
      const detail = buildErr.errors?.[0]?.text || (err instanceof Error ? err.message : 'JavaScript syntax error');
      addIssue({
        checkCategory: 'JavaScript Runtime / Console',
        name: `Inline <script> #${idx + 1} syntax error`,
        description: 'Inline JavaScript contains a syntax error that throws an uncaught browser console exception.',
        severity: 'critical',
        affectedUrl: finalUrl,
        evidence: detail,
        suggestedSolution: 'Fix the JavaScript syntax error in the inline script or move logic to a linted JS/TS bundle.',
      });
    }
    if (/\bdocument\.write\s*\(/.test(code)) {
      inlineScriptErrors++;
      addIssue({
        checkCategory: 'JavaScript Runtime / Console',
        name: 'Deprecated document.write() call detected',
        description: 'Inline script invokes document.write(), which can block parsing or overwrite the DOM.',
        severity: 'medium',
        affectedUrl: finalUrl,
        evidence: 'Matched document.write(...) in inline script.',
        suggestedSolution: 'Replace document.write() with standard DOM APIs such as appendChild or insertAdjacentHTML.',
      });
    }
  });

  // 8. Broken link, image, and subresource checks (bounded concurrency + SSRF checked)
  emit('Link & Subresource Probing', 'Checking page links, images, stylesheets, and scripts for broken HTTP responses');

  const resolveAbs = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return null;
    try {
      return new URL(trimmed, finalUrl).toString();
    } catch {
      return null;
    }
  };

  const linkUrls = new Set<string>();
  $('a[href]').each((_, el) => {
    const u = resolveAbs($(el).attr('href'));
    if (u && linkUrls.size < 10) linkUrls.add(u);
  });

  const imageUrls = new Set<string>();
  $('img[src]').each((_, el) => {
    const u = resolveAbs($(el).attr('src'));
    if (u && imageUrls.size < 8) imageUrls.add(u);
  });

  const resourceUrls = new Set<string>();
  $('link[rel="stylesheet"][href], script[src]').each((_, el) => {
    const u = resolveAbs($(el).attr('href') || $(el).attr('src'));
    if (u && resourceUrls.size < 8) resourceUrls.add(u);
  });

  const probeUrl = async (url: string): Promise<{ ok: boolean; status: number; error?: string }> => {
    try {
      const res = await safeExternalFetch(url, { method: 'HEAD', timeoutMs: 5000, maxRedirects: 3 });
      if (res.response.status === 405 || res.response.status === 501) {
        const getRes = await safeExternalFetch(url, { method: 'GET', timeoutMs: 5000, maxBytes: 16384, maxRedirects: 3 });
        return { ok: getRes.response.status < 400, status: getRes.response.status };
      }
      return { ok: res.response.status < 400, status: res.response.status };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Request failed' };
    }
  };

  let brokenLinksCount = 0;
  let brokenImagesCount = 0;

  const linkResults = await Promise.all([...linkUrls].map(async (u) => ({ url: u, ...(await probeUrl(u)) })));
  for (const r of linkResults) {
    if (!r.ok) {
      brokenLinksCount++;
      addIssue({
        checkCategory: 'Broken Links',
        name: `Broken link (${r.status ? `HTTP ${r.status}` : 'Unreachable'})`,
        description: `Outbound or internal hyperlink failed verification.`,
        severity: r.status === 404 || r.status >= 500 ? 'high' : 'medium',
        affectedUrl: r.url,
        evidence: r.error ? `Network error: ${r.error}` : `HTTP status ${r.status} returned for ${r.url}`,
        suggestedSolution: 'Update the href target to a valid working URL or remove the dead hyperlink.',
      });
    }
  }

  const imageResults = await Promise.all([...imageUrls].map(async (u) => ({ url: u, ...(await probeUrl(u)) })));
  for (const r of imageResults) {
    if (!r.ok) {
      brokenImagesCount++;
      addIssue({
        checkCategory: 'Missing Images & Resources',
        name: `Broken image asset (${r.status ? `HTTP ${r.status}` : 'Load failed'})`,
        description: 'An <img> resource could not be loaded.',
        severity: 'high',
        affectedUrl: r.url,
        evidence: r.error ? `Fetch error: ${r.error}` : `HTTP ${r.status} returned for image ${r.url}`,
        suggestedSolution: 'Restore the missing image file at the expected path or update the <img src> URL.',
      });
    }
  }

  const subResResults = await Promise.all([...resourceUrls].map(async (u) => ({ url: u, ...(await probeUrl(u)) })));
  for (const r of subResResults) {
    if (!r.ok) {
      addIssue({
        checkCategory: 'Failed Network Requests',
        name: `Failed stylesheet/script load (${r.status ? `HTTP ${r.status}` : 'Network error'})`,
        description: 'A page stylesheet or JavaScript bundle failed to load.',
        severity: 'critical',
        affectedUrl: r.url,
        evidence: r.error ? `Request error: ${r.error}` : `HTTP ${r.status} for ${r.url}`,
        suggestedSolution: 'Verify asset build output, CDN path, and CORS/permissions for this resource.',
      });
    }
  }

  // Missing favicon check
  const hasFavicon = $('link[rel*="icon"]').length > 0;
  if (!hasFavicon) {
    addIssue({
      checkCategory: 'Missing Page Resources',
      name: 'No explicit favicon link declared',
      description: 'HTML head does not declare a <link rel="icon"> resource.',
      severity: 'low',
      affectedUrl: finalUrl,
      evidence: 'No <link rel="icon"> or shortcut icon found in <head>.',
      suggestedSolution: 'Add <link rel="icon" href="/favicon.ico" /> in <head>.',
    });
  }

  // Attempt source mapping if active project has HTML files
  const projectHtmlFiles = (options.projectFiles ?? []).filter((f) => /\.html?$/i.test(f.relativePath));
  const hasSourceMatch = projectHtmlFiles.length > 0;
  if (hasSourceMatch) {
    for (const issue of issues) {
      if (['SEO', 'Accessibility', 'Responsive Layout', 'Missing Page Resources'].includes(issue.checkCategory)) {
        issue.matchedProjectFile = projectHtmlFiles[0].relativePath;
      }
    }
  }

  const critical = issues.filter((i) => i.severity === 'critical').length;
  const high = issues.filter((i) => i.severity === 'high').length;
  const medium = issues.filter((i) => i.severity === 'medium').length;
  const low = issues.filter((i) => i.severity === 'low').length;
  const score = Math.max(10, Math.min(100, 100 - critical * 20 - high * 12 - medium * 6 - low * 2));

  emit('Report Ready', `Completed diagnostic scan with ${issues.length} finding(s)`);

  return {
    url: targetUrl,
    finalUrl,
    status: 'completed',
    httpStatus,
    loadTimeMs,
    issues,
    metrics: {
      httpStatus,
      loadTimeMs,
      htmlSizeBytes,
      linksChecked: linkUrls.size,
      brokenLinksCount,
      imagesChecked: imageUrls.size,
      brokenImagesCount,
      scriptsFound: scriptTags.length,
      inlineScriptErrors,
      accessibilityIssues,
      seoIssues,
      performanceIssues,
      responsiveIssues,
      redirectCount: redirectChain.length,
    },
    summary: {
      totalIssues: issues.length,
      critical,
      high,
      medium,
      low,
      score,
      isExternalOnly: !hasSourceMatch,
      sourceAccessNote: hasSourceMatch
        ? `Linked active project HTML source (${projectHtmlFiles[0].relativePath}) is available in Code Workbench for review.`
        : 'External website diagnostic report only — AutoPatch AI does not modify third-party sites you do not control.',
    },
  };
}
