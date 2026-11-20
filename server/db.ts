import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import {
  analyzeProjectFiles,
  buildDependencyGraph,
  calculateProjectHealthScore,
  detectLanguage,
  evaluatePatchConfidenceAndRisk,
  type Severity,
} from './services/analyzer';
import { sha256 } from './services/security';

const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/autopatch.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const mediaStorageDir = path.resolve(process.cwd(), './data/uploads/media');
fs.mkdirSync(mediaStorageDir, { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'engineer',
      settings_json TEXT NOT NULL DEFAULT '{"ladybugEnabled":true,"soundEnabled":false,"autoSelectProject":true}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      languages_json TEXT NOT NULL DEFAULT '[]',
      total_files INTEGER NOT NULL DEFAULT 0,
      health_score INTEGER NOT NULL DEFAULT 100,
      last_scan_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      language TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, relative_path),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scan_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      current_stage TEXT NOT NULL DEFAULT 'Project validation',
      stages_json TEXT NOT NULL DEFAULT '[]',
      files_scanned INTEGER NOT NULL DEFAULT 0,
      bugs_found INTEGER NOT NULL DEFAULT 0,
      critical_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      error_message TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS detected_bugs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      scan_id TEXT,
      file_id TEXT,
      file_path TEXT NOT NULL,
      line_number INTEGER NOT NULL DEFAULT 1,
      column_number INTEGER NOT NULL DEFAULT 1,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      error_message TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      affected_code TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      source_tool TEXT NOT NULL DEFAULT 'Static Analyzer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (scan_id) REFERENCES scan_history(id) ON DELETE SET NULL,
      FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS suggested_fixes (
      id TEXT PRIMARY KEY,
      bug_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_id TEXT,
      file_path TEXT NOT NULL,
      original_code TEXT NOT NULL,
      proposed_code TEXT NOT NULL,
      approved_code TEXT,
      explanation TEXT NOT NULL,
      prevention_tips TEXT NOT NULL DEFAULT '',
      related_concepts_json TEXT NOT NULL DEFAULT '[]',
      confidence_score INTEGER NOT NULL,
      confidence_factors_json TEXT NOT NULL DEFAULT '[]',
      confidence_explanation TEXT NOT NULL DEFAULT '',
      risk_score INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      risk_factors_json TEXT NOT NULL DEFAULT '[]',
      risk_explanation TEXT NOT NULL DEFAULT '',
      validation_status TEXT NOT NULL DEFAULT 'warning',
      validation_details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (bug_id) REFERENCES detected_bugs(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      bug_id TEXT,
      fix_id TEXT,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS change_history (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_id TEXT,
      file_path TEXT NOT NULL,
      user_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS patch_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      bug_id TEXT,
      fix_id TEXT,
      file_id TEXT,
      file_path TEXT NOT NULL,
      original_content TEXT NOT NULL,
      patched_content TEXT NOT NULL,
      original_sha256 TEXT NOT NULL,
      patched_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied',
      applied_by TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      rolled_back_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS patch_audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      bug_id TEXT,
      bug_category TEXT NOT NULL DEFAULT 'General',
      fix_id TEXT,
      snapshot_id TEXT,
      action_type TEXT NOT NULL,
      action_status TEXT NOT NULL,
      risk_level TEXT NOT NULL DEFAULT 'Low',
      confidence_score INTEGER,
      risk_score INTEGER,
      file_path TEXT NOT NULL DEFAULT '',
      original_code TEXT NOT NULL DEFAULT '',
      proposed_code TEXT NOT NULL DEFAULT '',
      approved_code TEXT NOT NULL DEFAULT '',
      validation_result TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dependency_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_id TEXT,
      node_key TEXT NOT NULL,
      label TEXT NOT NULL,
      file_path TEXT NOT NULL,
      node_type TEXT NOT NULL DEFAULT 'file',
      language TEXT NOT NULL,
      loc INTEGER NOT NULL DEFAULT 0,
      bug_count INTEGER NOT NULL DEFAULT 0,
      max_severity TEXT NOT NULL DEFAULT 'none',
      in_degree INTEGER NOT NULL DEFAULT 0,
      out_degree INTEGER NOT NULL DEFAULT 0,
      impact_score INTEGER NOT NULL DEFAULT 0,
      exports_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(project_id, node_key),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS dependency_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      target_key TEXT NOT NULL,
      import_specifier TEXT NOT NULL,
      edge_type TEXT NOT NULL DEFAULT 'direct',
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS website_scan_results (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      final_url TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER NOT NULL DEFAULT 0,
      load_time_ms INTEGER NOT NULL DEFAULT 0,
      issues_json TEXT NOT NULL DEFAULT '[]',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      summary_json TEXT NOT NULL DEFAULT '{}',
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS multimedia_analysis (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      user_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      format TEXT NOT NULL,
      codec TEXT NOT NULL,
      duration_sec REAL,
      width INTEGER,
      height INTEGER,
      bitrate INTEGER,
      validation_status TEXT NOT NULL,
      problems_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      browser_preview_supported INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bug_learning_records (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      bug_id TEXT NOT NULL,
      fix_id TEXT NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      language TEXT NOT NULL,
      error_message TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      incorrect_code TEXT NOT NULL,
      corrected_code TEXT NOT NULL,
      why_it_works TEXT NOT NULL,
      prevention_guide TEXT NOT NULL,
      concepts_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      target_route TEXT NOT NULL DEFAULT '/',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_project ON uploaded_files(project_id);
    CREATE INDEX IF NOT EXISTS idx_bugs_project ON detected_bugs(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_fixes_bug ON suggested_fixes(bug_id);
    CREATE INDEX IF NOT EXISTS idx_audit_project ON patch_audit_events(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_dep_nodes_proj ON dependency_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_dep_edges_proj ON dependency_edges(project_id);
  `);
}

export async function seedInitialWorkspaceIfEmpty(): Promise<void> {
  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (userCount > 0) return;

  const userId = newId('usr');
  const passwordHash = bcrypt.hashSync('AutoPatch2026!', 10);
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, 'alex.chen@autopatch.dev', 'Alex Chen', passwordHash, 'admin');

  const projectId = newId('prj');
  const sampleFiles: Array<{ relativePath: string; content: string }> = [
    {
      relativePath: 'src/api/checkoutController.ts',
      content: `import { queryOrderById } from '../db/orderRepository';
import { calculateDiscount } from '../utils/pricing';
import { verifySessionToken } from '../auth/sessionGuard';

export async function handleCheckout(orderId: string, token: string, promoExpr: string) {
  const session = verifySessionToken(token);
  if (!session || session.role == 'guest') {
    throw new Error('Unauthorized checkout attempt');
  }

  const order = await queryOrderById(orderId);
  const discount = promoExpr ? eval(promoExpr) : calculateDiscount(order.subtotal, 0.1);
  return {
    orderId: order.id,
    total: Math.max(0, order.subtotal - discount),
  };
}
`,
    },
    {
      relativePath: 'src/db/orderRepository.ts',
      content: `export interface OrderRecord {
  id: string;
  subtotal: number;
  customerEmail: string;
}

export async function queryOrderById(orderId: string): Promise<OrderRecord> {
  const sql = \`SELECT id, subtotal, customer_email FROM orders WHERE id = '\${orderId}'\`;
  // Simulated query executor contract
  console.log('Executing query:', sql);
  return { id: orderId, subtotal: 149.0, customerEmail: 'buyer@example.com' };
}
`,
    },
    {
      relativePath: 'src/auth/sessionGuard.ts',
      content: `export interface SessionInfo {
  userId: string;
  role: string;
}

export function verifySessionToken(token: string): SessionInfo | null {
  try {
    if (!token || token.length < 8) return null;
    if (token == 'admin-bypass') {
      return { userId: 'root', role: 'admin' };
    }
    return { userId: 'usr_101', role: 'customer' };
  } catch (err) {
  }
  return null;
}
`,
    },
    {
      relativePath: 'src/utils/pricing.ts',
      content: `export function calculateDiscount(subtotal: number, rate: number): number {
  if (subtotal <= 0) return 0;
  return Number((subtotal * rate).toFixed(2));
}

export function calculateInstallment(total: number, count: number): number {
  if (count <= 0) return total;
  return Number((total / count).toFixed(2));
}
`,
    },
    {
      relativePath: 'services/fraud_scorer.py',
      content: `import subprocess

def collect_risk_signals(amount, flags=[]):
    flags.append(amount > 1000)
    return flags

def run_risk_audit(customer_id):
    try:
        output = subprocess.check_output(f"echo audit-{customer_id}", shell=True)
        return output.decode("utf-8").strip()
    except:
        return "audit-error"
`,
    },
    {
      relativePath: 'db/cleanup_expired.sql',
      content: `-- Nightly cleanup job for abandoned checkout sessions
DELETE FROM checkout_sessions;
`,
    },
    {
      relativePath: 'web/checkout.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PulsePay Checkout</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <h1>PulsePay Checkout</h1>
    <img src="assets/brand-logo.png" />
    <div id="receipt"></div>
  </main>
  <script src="../src/utils/pricing.ts"></script>
</body>
</html>
`,
    },
    {
      relativePath: 'web/styles.css',
      content: `body {
  background: #0b1220;
  color: #f1f5f9;
  font-family: sans-serif;
}

main {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
}
`,
    },
  ];

  const languages = [...new Set(sampleFiles.map((f) => detectLanguage(f.relativePath)))];
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (id, user_id, name, description, languages_json, total_files, health_score, last_scan_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    projectId,
    userId,
    'PulsePay Checkout Engine',
    'Multi-language payment checkout, fraud scoring, and SQL maintenance service.',
    JSON.stringify(languages),
    sampleFiles.length,
    100,
    now,
    now,
    now,
  );

  const fileRows: Array<{ id: string; relativePath: string; content: string; language: string }> = [];
  const insertFile = db.prepare(
    `INSERT INTO uploaded_files (id, project_id, relative_path, language, size_bytes, content, sha256, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const f of sampleFiles) {
    const fileId = newId('fil');
    const lang = detectLanguage(f.relativePath);
    insertFile.run(fileId, projectId, f.relativePath, lang, Buffer.byteLength(f.content, 'utf8'), f.content, sha256(f.content), now);
    fileRows.push({ id: fileId, relativePath: f.relativePath, content: f.content, language: lang });
  }

  // Run the REAL static analyzer on these sample files!
  const detectedIssues = await analyzeProjectFiles(fileRows);
  const scanId = newId('scn');
  const stages = [
    'Project validation',
    'File discovery',
    'Language detection',
    'Dependency analysis',
    'Static analysis',
    'AI analysis',
    'Bug classification',
    'Fix generation',
    'Result storage',
    'Report generation',
  ].map((name) => ({ name, status: 'completed' }));

  const criticalCount = detectedIssues.filter((i) => i.severity === 'critical').length;
  db.prepare(
    `INSERT INTO scan_history (id, project_id, user_id, status, current_stage, stages_json, files_scanned, bugs_found, critical_count, summary, started_at, completed_at)
     VALUES (?, ?, ?, 'completed', 'Report generation', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scanId,
    projectId,
    userId,
    JSON.stringify(stages),
    fileRows.length,
    detectedIssues.length,
    criticalCount,
    `Initial baseline scan discovered ${detectedIssues.length} issues (${criticalCount} critical) across ${fileRows.length} source files.`,
    now,
    now,
  );

  const fileIdByPath = new Map(fileRows.map((r) => [r.relativePath, r.id]));
  const insertBug = db.prepare(
    `INSERT INTO detected_bugs (id, project_id, scan_id, file_id, file_path, line_number, column_number, language, category, severity, title, error_message, root_cause, affected_code, status, source_tool, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  );

  const bugIdsByPath = new Map<string, string[]>();
  const insertedBugs: Array<{ id: string; issue: (typeof detectedIssues)[number] }> = [];

  for (const issue of detectedIssues) {
    const bugId = newId('bug');
    const fileId = fileIdByPath.get(issue.filePath) ?? null;
    insertBug.run(
      bugId,
      projectId,
      scanId,
      fileId,
      issue.filePath,
      issue.lineNumber,
      issue.columnNumber,
      issue.language,
      issue.category,
      issue.severity,
      issue.title,
      issue.errorMessage,
      issue.rootCause,
      issue.affectedCode,
      issue.sourceTool,
      now,
    );
    insertedBugs.push({ id: bugId, issue });
    const list = bugIdsByPath.get(issue.filePath) ?? [];
    list.push(bugId);
    bugIdsByPath.set(issue.filePath, list);

    db.prepare(
      `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, action_type, action_status, risk_level, file_path, original_code, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'bug_detected', 'recorded', ?, ?, ?, ?, ?)`,
    ).run(
      newId('aud'),
      userId,
      'Alex Chen',
      projectId,
      'PulsePay Checkout Engine',
      bugId,
      issue.category,
      issue.severity === 'critical' ? 'Critical' : issue.severity === 'high' ? 'High' : issue.severity === 'medium' ? 'Medium' : 'Low',
      issue.filePath,
      issue.affectedCode,
      `${issue.sourceTool}: ${issue.title} at line ${issue.lineNumber}`,
      now,
    );
  }

  // Also seed 1 already-resolved historical bug + snapshot + learning record on pricing.ts so Learn From Your Bugs & Rollback have immediate real history
  const pricingFile = fileRows.find((f) => f.relativePath === 'src/utils/pricing.ts')!;
  const oldPricingCode = `export function calculateDiscount(subtotal: number, rate: number): number {
  if (subtotal <= 0) return 0;
  return Number((subtotal * rate).toFixed(2));
}

export function calculateInstallment(total: number, count: number): number {
  return Number((total / count).toFixed(2));
}
`;
  const resolvedBugId = newId('bug');
  db.prepare(
    `INSERT INTO detected_bugs (id, project_id, scan_id, file_id, file_path, line_number, column_number, language, category, severity, title, error_message, root_cause, affected_code, status, source_tool, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 7, 1, 'TypeScript', 'Arithmetic Bug', 'high', 'Unchecked divisor in calculateInstallment()', 'Dividing total by count without guarding count <= 0 returns Infinity or NaN.', 'Zero or negative installment counts were passed directly to division without validation.', ?, 'resolved', 'TypeScript AST Quality Analyzer', ?, ?)`,
  ).run(resolvedBugId, projectId, scanId, pricingFile.id, pricingFile.relativePath, '7:   return Number((total / count).toFixed(2));', now, now);

  const evalSeed = evaluatePatchConfidenceAndRisk({
    filePath: pricingFile.relativePath,
    language: 'TypeScript',
    bugCategory: 'Arithmetic Bug',
    bugSeverity: 'high',
    originalCode: oldPricingCode,
    proposedCode: pricingFile.content,
    validationStatus: 'passed',
    validationDetails: 'Passed TypeScript/JavaScript AST syntax verification.',
    dependentFilesCount: 1,
    hasTestsInProject: false,
    hasAiRootCause: true,
  });

  const resolvedFixId = newId('fix');
  db.prepare(
    `INSERT INTO suggested_fixes (id, bug_id, project_id, file_id, file_path, original_code, proposed_code, approved_code, explanation, prevention_tips, related_concepts_json, confidence_score, confidence_factors_json, confidence_explanation, risk_score, risk_level, risk_factors_json, risk_explanation, validation_status, validation_details, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`,
  ).run(
    resolvedFixId,
    resolvedBugId,
    projectId,
    pricingFile.id,
    pricingFile.relativePath,
    oldPricingCode,
    pricingFile.content,
    pricingFile.content,
    'Added an explicit guard (if (count <= 0) return total;) before dividing so zero or negative installment counts never yield Infinity or NaN.',
    'Always validate numeric divisors and bounds at function entry points in financial calculations, and add boundary unit tests for 0 and negative values.',
    JSON.stringify(['Defensive Programming', 'Floating-Point Arithmetic', 'Input Validation', 'Boundary Testing']),
    evalSeed.confidenceScore,
    JSON.stringify(evalSeed.confidenceFactors),
    evalSeed.confidenceExplanation,
    evalSeed.riskScore,
    evalSeed.riskLevel,
    JSON.stringify(evalSeed.riskFactors),
    evalSeed.riskExplanation,
    evalSeed.validationStatus,
    evalSeed.validationDetails,
    now,
    now,
  );

  const snapshotId = newId('snp');
  db.prepare(
    `INSERT INTO patch_snapshots (id, project_id, bug_id, fix_id, file_id, file_path, original_content, patched_content, original_sha256, patched_sha256, status, applied_by, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`,
  ).run(
    snapshotId,
    projectId,
    resolvedBugId,
    resolvedFixId,
    pricingFile.id,
    pricingFile.relativePath,
    oldPricingCode,
    pricingFile.content,
    sha256(oldPricingCode),
    sha256(pricingFile.content),
    'Alex Chen',
    now,
  );

  db.prepare(
    `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id, snapshot_id, action_type, action_status, risk_level, confidence_score, risk_score, file_path, original_code, proposed_code, approved_code, validation_result, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Arithmetic Bug', ?, ?, 'patch_applied', 'verified', ?, ?, ?, ?, ?, ?, ?, ?, 'Approved and applied defensive divisor guard to src/utils/pricing.ts', ?)`,
  ).run(
    newId('aud'),
    userId,
    'Alex Chen',
    projectId,
    'PulsePay Checkout Engine',
    resolvedBugId,
    resolvedFixId,
    snapshotId,
    evalSeed.riskLevel,
    evalSeed.confidenceScore,
    evalSeed.riskScore,
    pricingFile.relativePath,
    oldPricingCode,
    pricingFile.content,
    pricingFile.content,
    evalSeed.validationDetails,
    now,
  );

  db.prepare(
    `INSERT INTO bug_learning_records (id, project_id, bug_id, fix_id, title, category, language, error_message, root_cause, incorrect_code, corrected_code, why_it_works, prevention_guide, concepts_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('lrn'),
    projectId,
    resolvedBugId,
    resolvedFixId,
    'Unchecked divisor in calculateInstallment()',
    'Arithmetic Bug',
    'TypeScript',
    'Dividing total by count without guarding count <= 0 returns Infinity or NaN.',
    'Zero or negative installment counts were passed directly to division without validation.',
    oldPricingCode,
    pricingFile.content,
    'Guarding count <= 0 before evaluating total / count short-circuits invalid divisors and preserves a finite numeric return value.',
    'Enforce explicit preconditions on numeric inputs in billing/pricing utilities and assert boundary values (0, -1, NaN) in unit tests.',
    JSON.stringify(['Defensive Programming', 'Floating-Point Arithmetic', 'Input Validation', 'Boundary Testing']),
    now,
  );

  // Build and persist REAL dependency graph for PulsePay Checkout Engine
  const bugsByFile = new Map<string, { count: number; maxSeverity: Severity | 'none' }>();
  const sevRank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  for (const b of insertedBugs) {
    const cur = bugsByFile.get(b.issue.filePath) ?? { count: 0, maxSeverity: 'none' as const };
    cur.count++;
    if (sevRank[b.issue.severity] > sevRank[cur.maxSeverity]) {
      cur.maxSeverity = b.issue.severity;
    }
    bugsByFile.set(b.issue.filePath, cur);
  }

  const depGraph = buildDependencyGraph(fileRows, bugsByFile);
  const insertNode = db.prepare(
    `INSERT INTO dependency_nodes (id, project_id, file_id, node_key, label, file_path, node_type, language, loc, bug_count, max_severity, in_degree, out_degree, impact_score, exports_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of depGraph.nodes) {
    insertNode.run(
      newId('nod'),
      projectId,
      n.fileId ?? null,
      n.key,
      n.label,
      n.filePath,
      n.nodeType,
      n.language,
      n.loc,
      n.bugCount,
      n.maxSeverity,
      n.inDegree,
      n.outDegree,
      n.impactScore,
      JSON.stringify(n.exports),
    );
  }

  const insertEdge = db.prepare(
    `INSERT INTO dependency_edges (id, project_id, source_key, target_key, import_specifier, edge_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const e of depGraph.edges) {
    insertEdge.run(newId('edg'), projectId, e.sourceKey, e.targetKey, e.importSpecifier, e.edgeType);
  }

  // Update project health score from real bugs
  const allProjectBugs = db.prepare('SELECT severity, status FROM detected_bugs WHERE project_id = ?').all(projectId) as Array<{
    severity: string;
    status: string;
  }>;
  const healthScore = calculateProjectHealthScore(allProjectBugs);
  db.prepare('UPDATE projects SET health_score = ? WHERE id = ?').run(healthScore, projectId);

  // Seed initial real notifications from the baseline scan & repair
  db.prepare(
    `INSERT INTO notifications (id, user_id, project_id, type, severity, title, message, target_route, is_read, created_at)
     VALUES (?, ?, ?, 'critical_issue', 'critical', ?, ?, '/workbench', 0, ?)`,
  ).run(
    newId('ntf'),
    userId,
    projectId,
    `${criticalCount} critical issues detected in PulsePay Checkout Engine`,
    `Static analysis flagged SQL injection, eval(), shell=True, and unbounded DELETE statements requiring review.`,
    now,
  );
  db.prepare(
    `INSERT INTO notifications (id, user_id, project_id, type, severity, title, message, target_route, is_read, created_at)
     VALUES (?, ?, ?, 'fix_verified', 'success', 'Patch verified on src/utils/pricing.ts', 'Defensive divisor guard passed TypeScript AST verification and snapshot was archived.', '/audit', 0, ?)`,
  ).run(newId('ntf'), userId, projectId, now);
}
