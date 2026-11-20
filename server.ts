import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { db, initDatabase, mediaStorageDir, newId, seedInitialWorkspaceIfEmpty } from './server/db';
import {
  analyzeProjectFiles,
  buildDependencyGraph,
  calculateProjectHealthScore,
  detectLanguage,
  evaluatePatchConfidenceAndRisk,
  getLanguageCapabilities,
  validatePatchedSyntax,
  type Severity,
} from './server/services/analyzer';
import {
  analyzeCodeWithGemini,
  generatePatchWithGemini,
  generatePatternRecommendationsWithGemini,
  isGeminiConfigured,
} from './server/services/gemini';
import {
  hashPassword,
  safelyExtractZipBuffer,
  sanitizeArchiveEntryPath,
  sha256,
  signToken,
  SUPPORTED_SOURCE_EXTENSIONS,
  verifyPassword,
  verifyToken,
  type AuthTokenPayload,
} from './server/services/security';
import { runWebsiteDebuggerScan } from './server/services/websiteDebugger';
import { inspectMultimediaFile, scanProjectMediaReferences } from './server/services/multimediaDebugger';

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function bootstrap() {
  initDatabase();
  await seedInitialWorkspaceIfEmpty();

  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
      frameguard: false,
    }),
  );
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api', apiLimiter);

  // Multer configurations with strict file limits
  const projectUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 40 },
  });

  const mediaUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, mediaStorageDir),
      filename: (_req, file, cb) => {
        const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10);
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${safeExt}`);
      },
    }),
    limits: { fileSize: 35 * 1024 * 1024, files: 1 },
  });

  // Helper to get default seeded user when no Bearer token is provided (so workspace loads immediately while supporting full JWT auth)
  function getDefaultUser(): AuthTokenPayload {
    const row = db.prepare('SELECT id, email, name, role FROM users ORDER BY created_at ASC LIMIT 1').get() as {
      id: string;
      email: string;
      name: string;
      role: string;
    };
    return { userId: row.id, email: row.email, name: row.name, role: row.role };
  }

  function resolveUserMiddleware(req: Request, _res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const payload = verifyToken(authHeader.slice(7));
      if (payload) {
        req.user = payload;
        return next();
      }
    }
    req.user = getDefaultUser();
    next();
  }

  app.use('/api', resolveUserMiddleware);

  // Socket.IO connection
  io.on('connection', (socket) => {
    socket.on('join:project', (projectId: string) => {
      if (typeof projectId === 'string' && projectId.length < 64) {
        socket.join(`project:${projectId}`);
      }
    });
  });

  function emitNotification(params: {
    userId: string;
    projectId?: string | null;
    type: string;
    severity: 'info' | 'success' | 'warning' | 'critical';
    title: string;
    message: string;
    targetRoute: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = newId('ntf');
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO notifications (id, user_id, project_id, type, severity, title, message, target_route, metadata_json, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      id,
      params.userId,
      params.projectId ?? null,
      params.type,
      params.severity,
      params.title,
      params.message,
      params.targetRoute,
      JSON.stringify(params.metadata ?? {}),
      createdAt,
    );

    const payload = {
      id,
      user_id: params.userId,
      project_id: params.projectId ?? null,
      type: params.type,
      severity: params.severity,
      title: params.title,
      message: params.message,
      target_route: params.targetRoute,
      metadata: params.metadata ?? {},
      is_read: 0,
      created_at: createdAt,
    };
    io.emit('notification:new', payload);
    return payload;
  }

  function refreshProjectDependencyGraph(projectId: string) {
    const files = db
      .prepare('SELECT id, relative_path, content, language FROM uploaded_files WHERE project_id = ?')
      .all(projectId) as Array<{ id: string; relative_path: string; content: string; language: string }>;

    const openBugs = db
      .prepare("SELECT file_path, severity FROM detected_bugs WHERE project_id = ? AND status != 'resolved'")
      .all(projectId) as Array<{ file_path: string; severity: Severity }>;

    const bugsByFile = new Map<string, { count: number; maxSeverity: Severity | 'none' }>();
    const sevRank: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    for (const b of openBugs) {
      const cur = bugsByFile.get(b.file_path) ?? { count: 0, maxSeverity: 'none' as const };
      cur.count++;
      if (sevRank[b.severity] > sevRank[cur.maxSeverity]) cur.maxSeverity = b.severity;
      bugsByFile.set(b.file_path, cur);
    }

    const graph = buildDependencyGraph(
      files.map((f) => ({ id: f.id, relativePath: f.relative_path, content: f.content, language: f.language })),
      bugsByFile,
    );

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM dependency_nodes WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM dependency_edges WHERE project_id = ?').run(projectId);

      const insNode = db.prepare(
        `INSERT INTO dependency_nodes (id, project_id, file_id, node_key, label, file_path, node_type, language, loc, bug_count, max_severity, in_degree, out_degree, impact_score, exports_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const n of graph.nodes) {
        insNode.run(
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

      const insEdge = db.prepare(
        `INSERT INTO dependency_edges (id, project_id, source_key, target_key, import_specifier, edge_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const e of graph.edges) {
        insEdge.run(newId('edg'), projectId, e.sourceKey, e.targetKey, e.importSpecifier, e.edgeType);
      }
    });
    tx();
    return graph;
  }

  function updateProjectMetrics(projectId: string) {
    const files = db.prepare('SELECT language FROM uploaded_files WHERE project_id = ?').all(projectId) as Array<{ language: string }>;
    const languages = [...new Set(files.map((f) => f.language))];
    const bugs = db.prepare('SELECT severity, status FROM detected_bugs WHERE project_id = ?').all(projectId) as Array<{
      severity: string;
      status: string;
    }>;
    const healthScore = calculateProjectHealthScore(bugs);
    db.prepare(
      `UPDATE projects SET languages_json = ?, total_files = ?, health_score = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(JSON.stringify(languages), files.length, healthScore, projectId);
  }

  // ==================== AUTH ROUTES ====================
  const registerSchema = z.object({
    name: z.string().min(2).max(80),
    email: z.string().email(),
    password: z.string().min(8).max(128),
  });

  app.post('/api/auth/register', async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid registration data.' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(parsed.data.email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const userId = newId('usr');
    const hash = await hashPassword(parsed.data.password);
    db.prepare('INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      parsed.data.email.toLowerCase(),
      parsed.data.name.trim(),
      hash,
      'engineer',
    );
    const payload: AuthTokenPayload = { userId, email: parsed.data.email.toLowerCase(), name: parsed.data.name.trim(), role: 'engineer' };
    const token = signToken(payload);
    return res.status(201).json({ token, user: payload });
  });

  app.post('/api/auth/login', async (req, res) => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password are required.' });
    }
    const row = db
      .prepare('SELECT id, email, name, password_hash, role, settings_json FROM users WHERE email = ?')
      .get(parsed.data.email.toLowerCase()) as
      | { id: string; email: string; name: string; password_hash: string; role: string; settings_json: string }
      | undefined;

    if (!row || !(await verifyPassword(parsed.data.password, row.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const payload: AuthTokenPayload = { userId: row.id, email: row.email, name: row.name, role: row.role };
    const token = signToken(payload);
    return res.json({ token, user: { ...payload, settings: JSON.parse(row.settings_json || '{}') } });
  });

  app.get('/api/auth/me', (req, res) => {
    const row = db
      .prepare('SELECT id, email, name, role, settings_json, created_at FROM users WHERE id = ?')
      .get(req.user!.userId) as
      | { id: string; email: string; name: string; role: string; settings_json: string; created_at: string }
      | undefined;
    if (!row) return res.status(404).json({ error: 'User not found.' });
    return res.json({
      user: {
        userId: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        settings: JSON.parse(row.settings_json || '{"ladybugEnabled":true}'),
        createdAt: row.created_at,
      },
    });
  });

  app.patch('/api/auth/settings', (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(80).optional(),
      ladybugEnabled: z.boolean().optional(),
      soundEnabled: z.boolean().optional(),
      autoSelectProject: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid settings payload.' });

    const row = db.prepare('SELECT name, settings_json FROM users WHERE id = ?').get(req.user!.userId) as {
      name: string;
      settings_json: string;
    };
    const current = JSON.parse(row.settings_json || '{}');
    const updated = {
      ...current,
      ...(parsed.data.ladybugEnabled !== undefined ? { ladybugEnabled: parsed.data.ladybugEnabled } : {}),
      ...(parsed.data.soundEnabled !== undefined ? { soundEnabled: parsed.data.soundEnabled } : {}),
      ...(parsed.data.autoSelectProject !== undefined ? { autoSelectProject: parsed.data.autoSelectProject } : {}),
    };
    const newName = parsed.data.name?.trim() || row.name;
    db.prepare('UPDATE users SET name = ?, settings_json = ? WHERE id = ?').run(
      newName,
      JSON.stringify(updated),
      req.user!.userId,
    );
    return res.json({ name: newName, settings: updated });
  });

  // ==================== REAL SYSTEM HEALTH & CAPABILITIES ====================
  app.get('/api/health', async (_req, res) => {
    let dbOk = false;
    let dbDetail = 'Unavailable';
    try {
      const r = db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number };
      dbOk = true;
      dbDetail = `SQLite WAL connected (${r.c} project${r.c === 1 ? '' : 's'})`;
    } catch (err) {
      dbDetail = err instanceof Error ? err.message : 'Database connection failed';
    }

    const aiConfigured = isGeminiConfigured();
    const capabilities = await getLanguageCapabilities();
    const fullAstCount = capabilities.filter((c) => c.supportLevel === 'full-ast').length;

    let fileEngineOk = false;
    let fileEngineDetail = 'Storage unavailable';
    try {
      fs.accessSync(mediaStorageDir, fs.constants.W_OK | fs.constants.R_OK);
      fileEngineOk = true;
      fileEngineDetail = 'ZIP extractor & FFprobe media pipeline writable';
    } catch {
      fileEngineDetail = 'Upload directory is not writable';
    }

    return res.json({
      timestamp: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      services: [
        {
          id: 'ai',
          name: 'AI Service (Gemini)',
          status: aiConfigured ? 'operational' : 'unavailable',
          detail: aiConfigured ? 'Server-side Gemini API configured (gemini-4-hydrogen)' : 'GEMINI_API_KEY not configured in environment',
        },
        {
          id: 'api',
          name: 'Backend API',
          status: 'operational',
          detail: `Express + Socket.IO active (uptime ${Math.round(process.uptime())}s)`,
        },
        {
          id: 'database',
          name: 'Database',
          status: dbOk ? 'operational' : 'unavailable',
          detail: dbDetail,
        },
        {
          id: 'analyzer',
          name: 'Code Analysis Engine',
          status: 'operational',
          detail: `${fullAstCount} native compiler/AST engines + ${capabilities.length - fullAstCount} static analyzers ready`,
        },
        {
          id: 'files',
          name: 'File Processing Engine',
          status: fileEngineOk ? 'operational' : 'degraded',
          detail: fileEngineDetail,
        },
      ],
    });
  });

  app.get('/api/capabilities', async (_req, res) => {
    const capabilities = await getLanguageCapabilities();
    return res.json({ capabilities });
  });

  // ==================== DASHBOARD & GLOBAL SEARCH ====================
  app.get('/api/dashboard', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;

    const projectFilterSql = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const totalBugs = (db.prepare(`SELECT COUNT(*) as c FROM detected_bugs ${projectFilterSql}`).get(...params) as { c: number }).c;
    const fixedBugs = (
      db
        .prepare(
          projectId
            ? "SELECT COUNT(*) as c FROM detected_bugs WHERE project_id = ? AND status = 'resolved'"
            : "SELECT COUNT(*) as c FROM detected_bugs WHERE status = 'resolved'",
        )
        .get(...params) as { c: number }
    ).c;
    const criticalIssues = (
      db
        .prepare(
          projectId
            ? "SELECT COUNT(*) as c FROM detected_bugs WHERE project_id = ? AND severity = 'critical' AND status != 'resolved'"
            : "SELECT COUNT(*) as c FROM detected_bugs WHERE severity = 'critical' AND status != 'resolved'",
        )
        .get(...params) as { c: number }
    ).c;

    const projects = db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as Array<{
      id: string;
      name: string;
      description: string;
      languages_json: string;
      total_files: number;
      health_score: number;
      last_scan_at: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const activeProjectRow = (projectId ? projects.find((p) => p.id === projectId) : projects[0]) ?? null;
    let avgHealth = 100;
    if (activeProjectRow) {
      avgHealth = activeProjectRow.health_score;
    } else if (projects.length > 0) {
      avgHealth = Math.round(projects.reduce((s, p) => s + p.health_score, 0) / projects.length);
    }

    const activeProjectOverview = activeProjectRow
      ? {
          id: activeProjectRow.id,
          name: activeProjectRow.name,
          description: activeProjectRow.description,
          languages: JSON.parse(activeProjectRow.languages_json || '[]') as string[],
          totalFiles: activeProjectRow.total_files,
          healthScore: activeProjectRow.health_score,
          lastScanAt: activeProjectRow.last_scan_at,
          detectedBugs: (
            db.prepare('SELECT COUNT(*) as c FROM detected_bugs WHERE project_id = ?').get(activeProjectRow.id) as { c: number }
          ).c,
          resolvedBugs: (
            db
              .prepare("SELECT COUNT(*) as c FROM detected_bugs WHERE project_id = ? AND status = 'resolved'")
              .get(activeProjectRow.id) as { c: number }
          ).c,
        }
      : null;

    const severityBreakdown = db
      .prepare(
        `SELECT severity, COUNT(*) as count FROM detected_bugs ${projectFilterSql} GROUP BY severity`,
      )
      .all(...params) as Array<{ severity: string; count: number }>;

    const recentActivity = db
      .prepare(
        `SELECT id, action_type, action_status, project_id, project_name, file_path, risk_level, details, user_name, created_at
         FROM patch_audit_events ${projectFilterSql} ORDER BY created_at DESC LIMIT 15`,
      )
      .all(...params);

    const recentScans = db
      .prepare(
        `SELECT s.id, s.project_id, p.name as project_name, s.status, s.files_scanned, s.bugs_found, s.critical_count, s.completed_at, s.started_at
         FROM scan_history s JOIN projects p ON p.id = s.project_id ${projectId ? 'WHERE s.project_id = ?' : ''}
         ORDER BY s.started_at DESC LIMIT 8`,
      )
      .all(...params);

    return res.json({
      kpis: {
        totalBugsDetected: totalBugs,
        bugsSuccessfullyFixed: fixedBugs,
        criticalIssues,
        projectHealthScore: avgHealth,
      },
      activeProject: activeProjectOverview,
      severityBreakdown,
      recentActivity,
      recentScans,
    });
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ projects: [], files: [], bugs: [], learning: [] });
    const like = `%${q}%`;

    const projects = db
      .prepare('SELECT id, name, description, health_score FROM projects WHERE name LIKE ? OR description LIKE ? LIMIT 5')
      .all(like, like);
    const files = db
      .prepare('SELECT id, project_id, relative_path, language FROM uploaded_files WHERE relative_path LIKE ? LIMIT 8')
      .all(like);
    const bugs = db
      .prepare(
        'SELECT id, project_id, file_path, title, category, severity, status FROM detected_bugs WHERE title LIKE ? OR error_message LIKE ? OR category LIKE ? OR file_path LIKE ? LIMIT 8',
      )
      .all(like, like, like, like);
    const learning = db
      .prepare('SELECT id, project_id, title, category, language FROM bug_learning_records WHERE title LIKE ? OR root_cause LIKE ? LIMIT 5')
      .all(like, like);

    return res.json({ projects, files, bugs, learning });
  });

  // ==================== PROJECTS & UPLOAD ====================
  app.get('/api/projects', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT p.*,
          (SELECT COUNT(*) FROM detected_bugs b WHERE b.project_id = p.id) as total_bugs,
          (SELECT COUNT(*) FROM detected_bugs b WHERE b.project_id = p.id AND b.status = 'resolved') as resolved_bugs,
          (SELECT COUNT(*) FROM detected_bugs b WHERE b.project_id = p.id AND b.severity = 'critical' AND b.status != 'resolved') as critical_bugs
         FROM projects p ORDER BY p.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return res.json({
      projects: rows.map((r) => ({
        ...r,
        languages: JSON.parse(String(r.languages_json || '[]')),
      })),
    });
  });

  app.post('/api/projects', (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(100),
      description: z.string().max(500).optional().default(''),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid project name.' });

    const id = newId('prj');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects (id, user_id, name, description, languages_json, total_files, health_score, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', 0, 100, ?, ?)`,
    ).run(id, req.user!.userId, parsed.data.name.trim(), parsed.data.description.trim(), now, now);

    return res.status(201).json({
      project: {
        id,
        name: parsed.data.name.trim(),
        description: parsed.data.description.trim(),
        languages: [],
        total_files: 0,
        health_score: 100,
        created_at: now,
      },
    });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const existing = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.params.id) as { id: string; name: string } | undefined;
    if (!existing) return res.status(404).json({ error: 'Project not found.' });
    db.prepare('DELETE FROM projects WHERE id = ?').run(existing.id);
    return res.json({ deleted: true, id: existing.id });
  });

  app.get('/api/projects/:id/files', (req, res) => {
    const files = db
      .prepare('SELECT id, project_id, relative_path, language, size_bytes, content, sha256, updated_at FROM uploaded_files WHERE project_id = ? ORDER BY relative_path ASC')
      .all(req.params.id);
    return res.json({ files });
  });

  app.put('/api/projects/:id/files/:fileId', (req, res) => {
    const schema = z.object({ content: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Content is required.' });

    const file = db
      .prepare('SELECT id, project_id, relative_path FROM uploaded_files WHERE id = ? AND project_id = ?')
      .get(req.params.fileId, req.params.id) as { id: string; project_id: string; relative_path: string } | undefined;
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const newHash = sha256(parsed.data.content);
    const size = Buffer.byteLength(parsed.data.content, 'utf8');
    db.prepare(
      `UPDATE uploaded_files SET content = ?, size_bytes = ?, sha256 = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(parsed.data.content, size, newHash, file.id);

    db.prepare(
      `INSERT INTO change_history (id, project_id, file_id, file_path, user_id, change_type, summary)
       VALUES (?, ?, ?, ?, ?, 'manual_edit', 'Saved edits from Code Workbench')`,
    ).run(newId('chg'), file.project_id, file.id, file.relative_path, req.user!.userId);

    refreshProjectDependencyGraph(file.project_id);
    return res.json({ saved: true, sha256: newHash, sizeBytes: size });
  });

  app.post('/api/projects/:id/upload', projectUpload.array('files', 40), (req, res) => {
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.params.id) as
      | { id: string; name: string }
      | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const uploaded = (req.files as Express.Multer.File[]) ?? [];
    if (uploaded.length === 0) {
      return res.status(400).json({ error: 'No files or ZIP archives uploaded.' });
    }

    const extractedFiles: Array<{ relativePath: string; content: string; sizeBytes: number }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const rejectedSecurityEntries: Array<{ path: string; reason: string }> = [];

    try {
      for (const file of uploaded) {
        const lower = file.originalname.toLowerCase();
        if (lower.endsWith('.zip') || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed') {
          const zipResult = safelyExtractZipBuffer(file.buffer);
          extractedFiles.push(...zipResult.files);
          skipped.push(...zipResult.skipped);
          rejectedSecurityEntries.push(...zipResult.rejectedSecurityEntries);
        } else {
          const clean = sanitizeArchiveEntryPath(file.originalname);
          if (!clean.safe || !clean.normalized) {
            rejectedSecurityEntries.push({ path: file.originalname, reason: clean.reason ?? 'Unsafe filename.' });
            continue;
          }
          const ext = path.posix.extname(clean.normalized).toLowerCase();
          if (!SUPPORTED_SOURCE_EXTENSIONS.has(ext)) {
            skipped.push({ path: clean.normalized, reason: `Unsupported source file extension (${ext || 'none'}).` });
            continue;
          }
          if (file.buffer.subarray(0, 8192).includes(0)) {
            skipped.push({ path: clean.normalized, reason: 'Binary file rejected in source upload.' });
            continue;
          }
          extractedFiles.push({
            relativePath: clean.normalized,
            content: file.buffer.toString('utf8'),
            sizeBytes: file.size,
          });
        }
      }
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to extract uploaded files safely.',
      });
    }

    if (extractedFiles.length === 0) {
      return res.status(400).json({
        error: 'No supported source files were found in the upload.',
        skipped,
        rejectedSecurityEntries,
      });
    }

    const upsert = db.prepare(`
      INSERT INTO uploaded_files (id, project_id, relative_path, language, size_bytes, content, sha256, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(project_id, relative_path) DO UPDATE SET
        language = excluded.language,
        size_bytes = excluded.size_bytes,
        content = excluded.content,
        sha256 = excluded.sha256,
        updated_at = datetime('now')
    `);

    const tx = db.transaction(() => {
      for (const f of extractedFiles) {
        const lang = detectLanguage(f.relativePath);
        upsert.run(newId('fil'), project.id, f.relativePath, lang, f.sizeBytes, f.content, sha256(f.content));
      }
    });
    tx();

    updateProjectMetrics(project.id);
    const depGraph = refreshProjectDependencyGraph(project.id);

    const languages = [...new Set(extractedFiles.map((f) => detectLanguage(f.relativePath)))];

    db.prepare(
      `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_category, action_type, action_status, risk_level, details)
       VALUES (?, ?, ?, ?, ?, 'Project', 'project_uploaded', 'completed', 'Low', ?)`,
    ).run(
      newId('aud'),
      req.user!.userId,
      req.user!.name,
      project.id,
      project.name,
      `Uploaded ${extractedFiles.length} source file(s) (${languages.join(', ')})`,
    );

    emitNotification({
      userId: req.user!.userId,
      projectId: project.id,
      type: 'project_uploaded',
      severity: 'info',
      title: `Uploaded ${extractedFiles.length} file(s) to ${project.name}`,
      message: `Languages detected: ${languages.join(', ')}. ${depGraph.edges.length} dependencies mapped.`,
      targetRoute: '/upload',
    });

    return res.status(201).json({
      uploadedCount: extractedFiles.length,
      languages,
      dependenciesFound: depGraph.edges.length,
      files: extractedFiles.map((f) => ({ relativePath: f.relativePath, language: detectLanguage(f.relativePath), sizeBytes: f.sizeBytes })),
      skipped,
      rejectedSecurityEntries,
    });
  });

  // ==================== REAL 10-STAGE SCANNING ENGINE ====================
  const SCAN_STAGES = [
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
  ];

  app.post('/api/projects/:id/scan', async (req, res) => {
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.params.id) as
      | { id: string; name: string }
      | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const useAiDeepScan = req.body?.enableAiAnalysis !== false && isGeminiConfigured();
    const scanId = newId('scn');
    const startedAt = new Date().toISOString();

    const stagesState = SCAN_STAGES.map((name) => ({ name, status: 'pending' as 'pending' | 'running' | 'completed' | 'skipped' | 'failed', detail: '' }));

    db.prepare(
      `INSERT INTO scan_history (id, project_id, user_id, status, current_stage, stages_json, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
    ).run(scanId, project.id, req.user!.userId, SCAN_STAGES[0], JSON.stringify(stagesState), startedAt);

    const updateStage = (idx: number, status: 'running' | 'completed' | 'skipped' | 'failed', detail: string) => {
      stagesState[idx] = { name: SCAN_STAGES[idx], status, detail };
      db.prepare('UPDATE scan_history SET current_stage = ?, stages_json = ? WHERE id = ?').run(
        SCAN_STAGES[idx],
        JSON.stringify(stagesState),
        scanId,
      );
      io.emit('scan:progress', {
        scanId,
        projectId: project.id,
        stageIndex: idx,
        stageName: SCAN_STAGES[idx],
        status,
        detail,
        stages: stagesState,
      });
    };

    try {
      // Stage 0: Project validation
      updateStage(0, 'running', `Validating workspace for ${project.name}`);
      const files = db
        .prepare('SELECT id, relative_path, language, content, size_bytes FROM uploaded_files WHERE project_id = ?')
        .all(project.id) as Array<{ id: string; relative_path: string; language: string; content: string; size_bytes: number }>;
      if (files.length === 0) {
        throw new Error('Project has no uploaded source files to scan. Upload files or a ZIP archive first.');
      }
      updateStage(0, 'completed', `Verified ${files.length} stored files.`);

      // Stage 1: File discovery
      updateStage(1, 'running', 'Indexing source files and line counts');
      const totalBytes = files.reduce((s, f) => s + f.size_bytes, 0);
      updateStage(1, 'completed', `Discovered ${files.length} files (${Math.round(totalBytes / 1024)} KB).`);

      // Stage 2: Language detection
      updateStage(2, 'running', 'Detecting programming languages and available compilers');
      const languages = [...new Set(files.map((f) => f.language))];
      updateStage(2, 'completed', `Languages: ${languages.join(', ')}`);

      // Stage 3: Dependency analysis
      updateStage(3, 'running', 'Extracting import, module, SQL, and asset dependency graph');
      const depGraph = refreshProjectDependencyGraph(project.id);
      updateStage(3, 'completed', `Mapped ${depGraph.nodes.length} nodes and ${depGraph.edges.length} edges.`);

      // Stage 4: Static analysis
      updateStage(4, 'running', 'Running TypeScript API, Python 3 AST, GCC/G++, JSON, and security analyzers');
      const staticIssues = await analyzeProjectFiles(
        files.map((f) => ({ relativePath: f.relative_path, content: f.content, language: f.language })),
      );
      updateStage(4, 'completed', `Static analyzers found ${staticIssues.length} issue(s).`);

      // Stage 5: AI analysis
      const combinedIssues = [...staticIssues];
      if (useAiDeepScan) {
        updateStage(5, 'running', 'Running context-aware Gemini code analysis on priority files');
        const priorityFiles = files.filter((f) => ['TypeScript', 'JavaScript', 'Python', 'C', 'C++', 'SQL'].includes(f.language)).slice(0, 3);
        let aiFound = 0;
        let aiErrorNote = '';
        for (const pf of priorityFiles) {
          try {
            const existingTitles = staticIssues.filter((i) => i.filePath === pf.relative_path).map((i) => i.title);
            const aiFindings = await analyzeCodeWithGemini({
              filePath: pf.relative_path,
              language: pf.language,
              content: pf.content,
              existingFindings: existingTitles,
            });
            for (const af of aiFindings) {
              const dup = combinedIssues.some(
                (x) => x.filePath === pf.relative_path && Math.abs(x.lineNumber - af.lineNumber) <= 2 && x.category === af.category,
              );
              if (!dup) {
                aiFound++;
                const lines = pf.content.split(/\r?\n/);
                const snippet = lines.slice(Math.max(0, af.lineNumber - 2), af.lineNumber + 2).join('\n');
                combinedIssues.push({
                  filePath: pf.relative_path,
                  lineNumber: af.lineNumber,
                  columnNumber: 1,
                  language: pf.language,
                  category: af.category,
                  severity: af.severity,
                  title: af.title,
                  errorMessage: af.errorMessage,
                  rootCause: af.rootCause,
                  affectedCode: snippet,
                  sourceTool: 'Gemini AI Analyzer (gemini-4-hydrogen)',
                });
              }
            }
          } catch (aiErr) {
            aiErrorNote = aiErr instanceof Error ? aiErr.message : 'Gemini request failed';
          }
        }
        updateStage(
          5,
          'completed',
          aiErrorNote ? `Gemini found ${aiFound} issue(s) (partial error: ${aiErrorNote.slice(0, 80)})` : `Gemini identified ${aiFound} additional deep issue(s).`,
        );
      } else {
        updateStage(5, 'skipped', isGeminiConfigured() ? 'AI deep analysis disabled for this run.' : 'GEMINI_API_KEY not configured; static engines completed.');
      }

      // Stage 6: Bug classification
      updateStage(6, 'running', 'Classifying severities and deduplicating against existing open issues');
      const criticalCount = combinedIssues.filter((i) => i.severity === 'critical').length;
      const highCount = combinedIssues.filter((i) => i.severity === 'high').length;
      updateStage(6, 'completed', `${criticalCount} critical, ${highCount} high, ${combinedIssues.length - criticalCount - highCount} medium/low.`);

      // Stage 7: Fix generation readiness
      updateStage(7, 'running', 'Preparing patch context & dependency fan-in metadata');
      updateStage(7, 'completed', 'Patch context ready for on-demand AI repair in Code Workbench.');

      // Stage 8: Result storage
      updateStage(8, 'running', 'Persisting scan results and bugs to SQLite database');
      const fileIdByPath = new Map(files.map((f) => [f.relative_path, f.id]));
      const existingOpen = db
        .prepare("SELECT file_path, line_number, title FROM detected_bugs WHERE project_id = ? AND status = 'open'")
        .all(project.id) as Array<{ file_path: string; line_number: number; title: string }>;
      const existingKey = new Set(existingOpen.map((b) => `${b.file_path}:${b.line_number}:${b.title}`));

      let newlyInsertedCount = 0;
      let highestSeverity: Severity = 'low';
      const sevOrder: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

      const insertBug = db.prepare(
        `INSERT INTO detected_bugs (id, project_id, scan_id, file_id, file_path, line_number, column_number, language, category, severity, title, error_message, root_cause, affected_code, status, source_tool)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      );
      const insertAudit = db.prepare(
        `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, action_type, action_status, risk_level, file_path, original_code, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'bug_detected', 'recorded', ?, ?, ?, ?)`,
      );

      for (const issue of combinedIssues) {
        if (sevOrder[issue.severity] > sevOrder[highestSeverity]) highestSeverity = issue.severity;
        const key = `${issue.filePath}:${issue.lineNumber}:${issue.title}`;
        if (existingKey.has(key)) continue;
        existingKey.add(key);

        const bugId = newId('bug');
        insertBug.run(
          bugId,
          project.id,
          scanId,
          fileIdByPath.get(issue.filePath) ?? null,
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
        );
        newlyInsertedCount++;

        insertAudit.run(
          newId('aud'),
          req.user!.userId,
          req.user!.name,
          project.id,
          project.name,
          bugId,
          issue.category,
          issue.severity === 'critical' ? 'Critical' : issue.severity === 'high' ? 'High' : issue.severity === 'medium' ? 'Medium' : 'Low',
          issue.filePath,
          issue.affectedCode,
          `${issue.sourceTool}: ${issue.title}`,
        );
      }

      refreshProjectDependencyGraph(project.id);
      updateProjectMetrics(project.id);
      const completedAt = new Date().toISOString();
      db.prepare('UPDATE projects SET last_scan_at = ? WHERE id = ?').run(completedAt, project.id);
      updateStage(8, 'completed', `Stored ${newlyInsertedCount} new bug(s) (${combinedIssues.length} total detected in scan).`);

      // Stage 9: Report generation
      const summaryText = `Scanned ${files.length} file(s) across ${languages.join(', ')}. Found ${combinedIssues.length} issue(s) (${criticalCount} critical, ${newlyInsertedCount} newly recorded).`;
      updateStage(9, 'completed', summaryText);

      db.prepare(
        `UPDATE scan_history SET status = 'completed', files_scanned = ?, bugs_found = ?, critical_count = ?, summary = ?, completed_at = ? WHERE id = ?`,
      ).run(files.length, combinedIssues.length, criticalCount, summaryText, completedAt, scanId);

      // Emit real backend bug:detected event for 3D Ladybug and live dashboard!
      if (combinedIssues.length > 0) {
        io.emit('bug:detected', {
          projectId: project.id,
          projectName: project.name,
          scanId,
          count: combinedIssues.length,
          criticalCount,
          severity: highestSeverity,
        });
      }

      emitNotification({
        userId: req.user!.userId,
        projectId: project.id,
        type: criticalCount > 0 ? 'critical_issue' : 'scan_completed',
        severity: criticalCount > 0 ? 'critical' : combinedIssues.length > 0 ? 'warning' : 'success',
        title:
          criticalCount > 0
            ? `Critical bugs detected in ${project.name}`
            : `Scan completed for ${project.name}`,
        message: summaryText,
        targetRoute: '/workbench',
        metadata: { scanId, bugsFound: combinedIssues.length, criticalCount },
      });

      return res.json({
        scanId,
        status: 'completed',
        filesScanned: files.length,
        bugsFound: combinedIssues.length,
        newlyRecorded: newlyInsertedCount,
        criticalCount,
        summary: summaryText,
        stages: stagesState,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Scan failed unexpectedly.';
      db.prepare(`UPDATE scan_history SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`).run(
        msg,
        scanId,
      );
      emitNotification({
        userId: req.user!.userId,
        projectId: project.id,
        type: 'scan_failed',
        severity: 'critical',
        title: `Scan failed for ${project.name}`,
        message: msg,
        targetRoute: '/upload',
      });
      return res.status(400).json({ error: msg, scanId });
    }
  });

  app.get('/api/projects/:id/scans', (req, res) => {
    const scans = db
      .prepare('SELECT * FROM scan_history WHERE project_id = ? ORDER BY started_at DESC LIMIT 25')
      .all(req.params.id) as Array<Record<string, unknown>>;
    return res.json({
      scans: scans.map((s) => ({ ...s, stages: JSON.parse(String(s.stages_json || '[]')) })),
    });
  });

  // ==================== BUGS, AI PATCHING, APPROVAL & ROLLBACK ====================
  app.get('/api/projects/:id/bugs', (req, res) => {
    const bugs = db
      .prepare("SELECT * FROM detected_bugs WHERE project_id = ? ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC")
      .all(req.params.id) as Array<Record<string, unknown>>;

    const fixes = db
      .prepare('SELECT * FROM suggested_fixes WHERE project_id = ? ORDER BY created_at DESC')
      .all(req.params.id) as Array<Record<string, unknown>>;

    const latestFixByBug = new Map<string, Record<string, unknown>>();
    for (const f of fixes) {
      const bid = String(f.bug_id);
      if (!latestFixByBug.has(bid)) {
        latestFixByBug.set(bid, {
          ...f,
          confidenceFactors: JSON.parse(String(f.confidence_factors_json || '[]')),
          riskFactors: JSON.parse(String(f.risk_factors_json || '[]')),
          relatedConcepts: JSON.parse(String(f.related_concepts_json || '[]')),
        });
      }
    }

    return res.json({
      bugs: bugs.map((b) => ({
        ...b,
        latestFix: latestFixByBug.get(String(b.id)) ?? null,
      })),
    });
  });

  app.post('/api/bugs/:bugId/generate-fix', async (req, res) => {
    const bug = db.prepare('SELECT * FROM detected_bugs WHERE id = ?').get(req.params.bugId) as
      | {
          id: string;
          project_id: string;
          file_id: string | null;
          file_path: string;
          line_number: number;
          language: string;
          category: string;
          severity: Severity;
          title: string;
          error_message: string;
          root_cause: string;
        }
      | undefined;
    if (!bug) return res.status(404).json({ error: 'Bug not found.' });

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(bug.project_id) as { id: string; name: string };
    const file = db
      .prepare('SELECT id, relative_path, content, language FROM uploaded_files WHERE project_id = ? AND relative_path = ?')
      .get(bug.project_id, bug.file_path) as { id: string; relative_path: string; content: string; language: string } | undefined;

    if (!file) return res.status(404).json({ error: `Source file "${bug.file_path}" not found in project.` });

    if (!isGeminiConfigured()) {
      return res.status(503).json({
        error: 'Gemini API key is not configured on the server. Add GEMINI_API_KEY in Settings > Secrets to generate AI patches.',
      });
    }

    try {
      const aiPatch = await generatePatchWithGemini({
        filePath: file.relative_path,
        language: file.language,
        fullFileContent: file.content,
        bugTitle: bug.title,
        bugCategory: bug.category,
        errorMessage: bug.error_message,
        rootCause: bug.root_cause,
        lineNumber: bug.line_number,
      });

      // Validate the generated patch using real compiler/AST syntax verification
      const validation = await validatePatchedSyntax(file.relative_path, aiPatch.proposedCode, file.language);

      // Pull real dependency fan-in from dependency_nodes
      const depNode = db
        .prepare('SELECT in_degree FROM dependency_nodes WHERE project_id = ? AND file_path = ?')
        .get(bug.project_id, file.relative_path) as { in_degree: number } | undefined;

      const testFilesCount = (
        db
          .prepare("SELECT COUNT(*) as c FROM uploaded_files WHERE project_id = ? AND (relative_path LIKE '%test%' OR relative_path LIKE '%spec%')")
          .get(bug.project_id) as { c: number }
      ).c;

      const evaluation = evaluatePatchConfidenceAndRisk({
        filePath: file.relative_path,
        language: file.language,
        bugCategory: bug.category,
        bugSeverity: bug.severity,
        originalCode: file.content,
        proposedCode: aiPatch.proposedCode,
        validationStatus: validation.status,
        validationDetails: validation.details,
        dependentFilesCount: depNode?.in_degree ?? 0,
        hasTestsInProject: testFilesCount > 0,
        hasAiRootCause: Boolean(aiPatch.rootCause),
      });

      const fixId = newId('fix');
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO suggested_fixes (
          id, bug_id, project_id, file_id, file_path, original_code, proposed_code, explanation,
          prevention_tips, related_concepts_json, confidence_score, confidence_factors_json,
          confidence_explanation, risk_score, risk_level, risk_factors_json, risk_explanation,
          validation_status, validation_details, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        fixId,
        bug.id,
        bug.project_id,
        file.id,
        file.relative_path,
        file.content,
        aiPatch.proposedCode,
        aiPatch.explanation,
        aiPatch.preventionTips,
        JSON.stringify(aiPatch.relatedConcepts),
        evaluation.confidenceScore,
        JSON.stringify(evaluation.confidenceFactors),
        evaluation.confidenceExplanation,
        evaluation.riskScore,
        evaluation.riskLevel,
        JSON.stringify(evaluation.riskFactors),
        evaluation.riskExplanation,
        evaluation.validationStatus,
        evaluation.validationDetails,
        now,
        now,
      );

      db.prepare('UPDATE detected_bugs SET root_cause = ? WHERE id = ?').run(aiPatch.rootCause, bug.id);

      db.prepare(
        `INSERT INTO patch_audit_events (
          id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id,
          action_type, action_status, risk_level, confidence_score, risk_score, file_path,
          original_code, proposed_code, validation_result, details, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'patch_generated', 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('aud'),
        req.user!.userId,
        req.user!.name,
        project.id,
        project.name,
        bug.id,
        bug.category,
        fixId,
        evaluation.riskLevel,
        evaluation.confidenceScore,
        evaluation.riskScore,
        file.relative_path,
        file.content,
        aiPatch.proposedCode,
        evaluation.validationDetails,
        `Generated AI patch (Confidence ${evaluation.confidenceScore}/100, ${evaluation.riskLevel} Risk ${evaluation.riskScore}/100)`,
        now,
      );

      emitNotification({
        userId: req.user!.userId,
        projectId: project.id,
        type: 'patch_generated',
        severity: 'info',
        title: `AI patch ready for ${path.basename(file.relative_path)}`,
        message: `Confidence ${evaluation.confidenceScore}/100 · ${evaluation.riskLevel} Risk (${evaluation.riskScore}/100). Awaiting explicit approval.`,
        targetRoute: '/workbench',
        metadata: { bugId: bug.id, fixId },
      });

      return res.json({
        fix: {
          id: fixId,
          bug_id: bug.id,
          project_id: bug.project_id,
          file_id: file.id,
          file_path: file.relative_path,
          original_code: file.content,
          proposed_code: aiPatch.proposedCode,
          explanation: aiPatch.explanation,
          prevention_tips: aiPatch.preventionTips,
          relatedConcepts: aiPatch.relatedConcepts,
          confidence_score: evaluation.confidenceScore,
          confidenceFactors: evaluation.confidenceFactors,
          confidence_explanation: evaluation.confidenceExplanation,
          risk_score: evaluation.riskScore,
          risk_level: evaluation.riskLevel,
          riskFactors: evaluation.riskFactors,
          risk_explanation: evaluation.riskExplanation,
          validation_status: evaluation.validationStatus,
          validation_details: evaluation.validationDetails,
          status: 'pending',
          created_at: now,
        },
        rootCause: aiPatch.rootCause,
      });
    } catch (err) {
      return res.status(502).json({
        error: `Gemini patch generation failed: ${err instanceof Error ? err.message : 'Upstream error'}`,
      });
    }
  });

  app.post('/api/fixes/:fixId/approve', async (req, res) => {
    const fix = db.prepare('SELECT * FROM suggested_fixes WHERE id = ?').get(req.params.fixId) as
      | {
          id: string;
          bug_id: string;
          project_id: string;
          file_id: string;
          file_path: string;
          original_code: string;
          proposed_code: string;
          explanation: string;
          prevention_tips: string;
          related_concepts_json: string;
          confidence_score: number;
          risk_score: number;
          risk_level: string;
          status: string;
        }
      | undefined;
    if (!fix) return res.status(404).json({ error: 'Suggested fix not found.' });

    const approvedCode = typeof req.body?.approvedCode === 'string' && req.body.approvedCode.length > 0 ? req.body.approvedCode : fix.proposed_code;
    const wasModified = approvedCode !== fix.proposed_code;

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(fix.project_id) as { id: string; name: string };
    const bug = db.prepare('SELECT * FROM detected_bugs WHERE id = ?').get(fix.bug_id) as {
      id: string;
      title: string;
      category: string;
      language: string;
      error_message: string;
      root_cause: string;
    };
    const currentFile = db
      .prepare('SELECT id, relative_path, content, language, sha256 FROM uploaded_files WHERE project_id = ? AND relative_path = ?')
      .get(fix.project_id, fix.file_path) as { id: string; relative_path: string; content: string; language: string; sha256: string } | undefined;

    if (!currentFile) return res.status(404).json({ error: 'Target file no longer exists in project.' });

    // Real verification on approved code
    const validation = await validatePatchedSyntax(currentFile.relative_path, approvedCode, currentFile.language);

    const snapshotId = newId('snp');
    const now = new Date().toISOString();
    const origHash = sha256(currentFile.content);
    const patchedHash = sha256(approvedCode);

    const tx = db.transaction(() => {
      // 1. Save recoverable snapshot BEFORE modifying file
      db.prepare(
        `INSERT INTO patch_snapshots (id, project_id, bug_id, fix_id, file_id, file_path, original_content, patched_content, original_sha256, patched_sha256, status, applied_by, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`,
      ).run(
        snapshotId,
        project.id,
        bug.id,
        fix.id,
        currentFile.id,
        currentFile.relative_path,
        currentFile.content,
        approvedCode,
        origHash,
        patchedHash,
        req.user!.name,
        now,
      );

      // 2. Apply approved patch to uploaded_files
      db.prepare(
        `UPDATE uploaded_files SET content = ?, size_bytes = ?, sha256 = ?, updated_at = ? WHERE id = ?`,
      ).run(approvedCode, Buffer.byteLength(approvedCode, 'utf8'), patchedHash, now, currentFile.id);

      // 3. Update fix & bug statuses
      db.prepare(
        `UPDATE suggested_fixes SET approved_code = ?, validation_status = ?, validation_details = ?, status = 'applied', updated_at = ? WHERE id = ?`,
      ).run(approvedCode, validation.status, validation.details, now, fix.id);

      db.prepare(`UPDATE detected_bugs SET status = 'resolved', resolved_at = ? WHERE id = ?`).run(now, bug.id);

      // 4. Record audit events (modified if edited, approved, applied & verified)
      if (wasModified) {
        db.prepare(
          `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id, snapshot_id, action_type, action_status, risk_level, confidence_score, risk_score, file_path, original_code, proposed_code, approved_code, validation_result, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'patch_modified', 'recorded', ?, ?, ?, ?, ?, ?, ?, ?, 'Engineer customized proposed patch before approval', ?)`,
        ).run(
          newId('aud'),
          req.user!.userId,
          req.user!.name,
          project.id,
          project.name,
          bug.id,
          bug.category,
          fix.id,
          snapshotId,
          fix.risk_level,
          fix.confidence_score,
          fix.risk_score,
          currentFile.relative_path,
          currentFile.content,
          fix.proposed_code,
          approvedCode,
          validation.details,
          now,
        );
      }

      db.prepare(
        `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id, snapshot_id, action_type, action_status, risk_level, confidence_score, risk_score, file_path, original_code, proposed_code, approved_code, validation_result, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'patch_applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('aud'),
        req.user!.userId,
        req.user!.name,
        project.id,
        project.name,
        bug.id,
        bug.category,
        fix.id,
        snapshotId,
        validation.status === 'passed' ? 'verified' : 'applied_with_warning',
        fix.risk_level,
        fix.confidence_score,
        fix.risk_score,
        currentFile.relative_path,
        currentFile.content,
        fix.proposed_code,
        approvedCode,
        validation.details,
        `Approved & applied patch to ${currentFile.relative_path}. Snapshot ${snapshotId} saved.`,
        now,
      );

      // 5. Create Learn From Your Bugs record from actual bug & accepted patch
      db.prepare(
        `INSERT INTO bug_learning_records (id, project_id, bug_id, fix_id, title, category, language, error_message, root_cause, incorrect_code, corrected_code, why_it_works, prevention_guide, concepts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newId('lrn'),
        project.id,
        bug.id,
        fix.id,
        bug.title,
        bug.category,
        bug.language,
        bug.error_message,
        bug.root_cause,
        currentFile.content,
        approvedCode,
        fix.explanation,
        fix.prevention_tips || 'Review input boundaries and run static analyzers before committing changes.',
        fix.related_concepts_json || '[]',
        now,
      );

      // 6. Store verification test_results row
      db.prepare(
        `INSERT INTO test_results (id, project_id, bug_id, fix_id, tool_name, status, output, created_at)
         VALUES (?, ?, ?, ?, 'Syntax & AST Verifier', ?, ?, ?)`,
      ).run(newId('tst'), project.id, bug.id, fix.id, validation.status, validation.details, now);
    });
    tx();

    refreshProjectDependencyGraph(project.id);
    updateProjectMetrics(project.id);

    // Emit real repair event for 3D Ladybug celebration animation!
    io.emit('bug:repaired', {
      projectId: project.id,
      bugId: bug.id,
      filePath: currentFile.relative_path,
      title: bug.title,
      validationStatus: validation.status,
    });

    emitNotification({
      userId: req.user!.userId,
      projectId: project.id,
      type: 'fix_verified',
      severity: 'success',
      title: `Patch applied & verified on ${path.basename(currentFile.relative_path)}`,
      message: `${validation.details} Snapshot ${snapshotId} archived for one-click rollback.`,
      targetRoute: '/audit',
      metadata: { snapshotId, bugId: bug.id, fixId: fix.id },
    });

    return res.json({
      applied: true,
      snapshotId,
      validation,
      newSha256: patchedHash,
    });
  });

  app.post('/api/fixes/:fixId/reject', (req, res) => {
    const fix = db.prepare('SELECT * FROM suggested_fixes WHERE id = ?').get(req.params.fixId) as
      | {
          id: string;
          bug_id: string;
          project_id: string;
          file_path: string;
          original_code: string;
          proposed_code: string;
          confidence_score: number;
          risk_score: number;
          risk_level: string;
        }
      | undefined;
    if (!fix) return res.status(404).json({ error: 'Fix not found.' });

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(fix.project_id) as { id: string; name: string };
    const bug = db.prepare('SELECT category FROM detected_bugs WHERE id = ?').get(fix.bug_id) as { category: string };
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'Rejected by engineer during review';

    db.prepare(`UPDATE suggested_fixes SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(fix.id);

    db.prepare(
      `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id, action_type, action_status, risk_level, confidence_score, risk_score, file_path, original_code, proposed_code, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'patch_rejected', 'rejected', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('aud'),
      req.user!.userId,
      req.user!.name,
      project.id,
      project.name,
      fix.bug_id,
      bug.category,
      fix.id,
      fix.risk_level,
      fix.confidence_score,
      fix.risk_score,
      fix.file_path,
      fix.original_code,
      fix.proposed_code,
      reason,
    );

    return res.json({ rejected: true, fixId: fix.id });
  });

  app.get('/api/projects/:id/snapshots', (req, res) => {
    const snapshots = db
      .prepare('SELECT * FROM patch_snapshots WHERE project_id = ? ORDER BY applied_at DESC')
      .all(req.params.id);
    return res.json({ snapshots });
  });

  app.post('/api/snapshots/:snapshotId/rollback', (req, res) => {
    const force = req.body?.force === true;
    const snap = db.prepare('SELECT * FROM patch_snapshots WHERE id = ?').get(req.params.snapshotId) as
      | {
          id: string;
          project_id: string;
          bug_id: string | null;
          fix_id: string | null;
          file_id: string | null;
          file_path: string;
          original_content: string;
          patched_content: string;
          original_sha256: string;
          patched_sha256: string;
          status: string;
        }
      | undefined;
    if (!snap) return res.status(404).json({ error: 'Snapshot not found.' });
    if (snap.status === 'rolled_back') {
      return res.status(400).json({ error: 'This snapshot has already been rolled back.' });
    }

    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(snap.project_id) as { id: string; name: string };
    const currentFile = db
      .prepare('SELECT id, content, sha256 FROM uploaded_files WHERE project_id = ? AND relative_path = ?')
      .get(snap.project_id, snap.file_path) as { id: string; content: string; sha256: string } | undefined;

    if (!currentFile) return res.status(404).json({ error: `Target file "${snap.file_path}" not found.` });

    // Conflict detection: ensure we don't silently overwrite subsequent manual edits or newer patches!
    if (currentFile.sha256 !== snap.patched_sha256 && !force) {
      return res.status(409).json({
        conflict: true,
        error: `Conflict detected on "${snap.file_path}": the file was modified after this patch was applied. Inspect the diff and confirm force rollback if you want to restore this snapshot.`,
        currentContent: currentFile.content,
        snapshotOriginalContent: snap.original_content,
      });
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE uploaded_files SET content = ?, size_bytes = ?, sha256 = ?, updated_at = ? WHERE id = ?').run(
        snap.original_content,
        Buffer.byteLength(snap.original_content, 'utf8'),
        snap.original_sha256,
        now,
        currentFile.id,
      );

      db.prepare("UPDATE patch_snapshots SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?").run(now, snap.id);

      if (snap.bug_id) {
        db.prepare("UPDATE detected_bugs SET status = 'open', resolved_at = NULL WHERE id = ?").run(snap.bug_id);
      }
      if (snap.fix_id) {
        db.prepare("UPDATE suggested_fixes SET status = 'rolled_back', updated_at = ? WHERE id = ?").run(now, snap.fix_id);
      }

      const bugCat = snap.bug_id
        ? ((db.prepare('SELECT category FROM detected_bugs WHERE id = ?').get(snap.bug_id) as { category: string } | undefined)?.category ?? 'General')
        : 'General';

      db.prepare(
        `INSERT INTO patch_audit_events (id, user_id, user_name, project_id, project_name, bug_id, bug_category, fix_id, snapshot_id, action_type, action_status, risk_level, file_path, original_code, approved_code, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'patch_rolled_back', 'restored', 'Medium', ?, ?, ?, ?, ?)`,
      ).run(
        newId('aud'),
        req.user!.userId,
        req.user!.name,
        project.id,
        project.name,
        snap.bug_id,
        bugCat,
        snap.fix_id,
        snap.id,
        snap.file_path,
        currentFile.content,
        snap.original_content,
        `Rolled back ${snap.file_path} to pre-patch snapshot ${snap.id}${force ? ' (conflict override confirmed)' : ''}`,
        now,
      );
    });
    tx();

    refreshProjectDependencyGraph(project.id);
    updateProjectMetrics(project.id);

    emitNotification({
      userId: req.user!.userId,
      projectId: project.id,
      type: 'rollback_completed',
      severity: 'warning',
      title: `Rollback completed on ${path.basename(snap.file_path)}`,
      message: `Original file version restored from snapshot ${snap.id}. Audit trail preserved.`,
      targetRoute: '/audit',
      metadata: { snapshotId: snap.id },
    });

    return res.json({ rolledBack: true, snapshotId: snap.id, filePath: snap.file_path });
  });

  // ==================== CODE IMPACT RADAR ====================
  app.get('/api/projects/:id/dependencies', (req, res) => {
    let nodes = db.prepare('SELECT * FROM dependency_nodes WHERE project_id = ?').all(req.params.id) as Array<Record<string, unknown>>;
    if (nodes.length === 0) {
      refreshProjectDependencyGraph(req.params.id);
      nodes = db.prepare('SELECT * FROM dependency_nodes WHERE project_id = ?').all(req.params.id) as Array<Record<string, unknown>>;
    }
    const edges = db.prepare('SELECT * FROM dependency_edges WHERE project_id = ?').all(req.params.id) as Array<Record<string, unknown>>;
    return res.json({
      nodes: nodes.map((n) => ({
        ...n,
        exports: JSON.parse(String(n.exports_json || '[]')),
      })),
      edges,
    });
  });

  // ==================== BUG PATTERN INTELLIGENCE & LEARNING CENTRE ====================
  app.get('/api/intelligence/patterns', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    const where = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const byCategory = db
      .prepare(`SELECT category, COUNT(*) as count, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved FROM detected_bugs ${where} GROUP BY category ORDER BY count DESC`)
      .all(...params) as Array<{ category: string; count: number; resolved: number }>;

    const byFile = db
      .prepare(`SELECT file_path as filePath, language, COUNT(*) as count, SUM(CASE WHEN severity='critical' THEN 1 ELSE 0 END) as criticalCount FROM detected_bugs ${where} GROUP BY file_path ORDER BY count DESC LIMIT 10`)
      .all(...params) as Array<{ filePath: string; language: string; count: number; criticalCount: number }>;

    const repeatedErrors = db
      .prepare(`SELECT error_message as errorMessage, category, COUNT(*) as occurrences FROM detected_bugs ${where} GROUP BY error_message ORDER BY occurrences DESC LIMIT 8`)
      .all(...params) as Array<{ errorMessage: string; category: string; occurrences: number }>;

    const commonRootCauses = db
      .prepare(`SELECT root_cause as rootCause, category, COUNT(*) as occurrences FROM detected_bugs ${where} GROUP BY root_cause ORDER BY occurrences DESC LIMIT 8`)
      .all(...params) as Array<{ rootCause: string; category: string; occurrences: number }>;

    const timeline = db
      .prepare(`SELECT substr(created_at, 1, 10) as date, COUNT(*) as detected, SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved FROM detected_bugs ${where} GROUP BY substr(created_at, 1, 10) ORDER BY date ASC`)
      .all(...params) as Array<{ date: string; detected: number; resolved: number }>;

    const byLanguage = db
      .prepare(`SELECT language, COUNT(*) as count FROM detected_bugs ${where} GROUP BY language ORDER BY count DESC`)
      .all(...params) as Array<{ language: string; count: number }>;

    return res.json({
      byCategory,
      byFile,
      repeatedErrors,
      commonRootCauses,
      timeline,
      byLanguage,
    });
  });

  app.post('/api/intelligence/recommendations', async (req, res) => {
    const projectId = typeof req.body?.projectId === 'string' && req.body.projectId ? req.body.projectId : null;
    if (!isGeminiConfigured()) {
      return res.status(503).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    const where = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];
    const totalBugs = (db.prepare(`SELECT COUNT(*) as c FROM detected_bugs ${where}`).get(...params) as { c: number }).c;
    if (totalBugs === 0) {
      return res.status(400).json({ error: 'No historical bug records found yet. Run a scan first.' });
    }

    const projectName = projectId
      ? ((db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name ?? 'Project')
      : 'All Workspace Projects';
    const topCategories = db
      .prepare(`SELECT category, COUNT(*) as count FROM detected_bugs ${where} GROUP BY category ORDER BY count DESC LIMIT 6`)
      .all(...params) as Array<{ category: string; count: number }>;
    const hotspotFiles = db
      .prepare(`SELECT file_path as filePath, COUNT(*) as count FROM detected_bugs ${where} GROUP BY file_path ORDER BY count DESC LIMIT 6`)
      .all(...params) as Array<{ filePath: string; count: number }>;
    const sampleErrors = (
      db.prepare(`SELECT error_message FROM detected_bugs ${where} ORDER BY created_at DESC LIMIT 10`).all(...params) as Array<{
        error_message: string;
      }>
    ).map((r) => r.error_message);

    try {
      const recommendations = await generatePatternRecommendationsWithGemini({
        projectName,
        totalBugs,
        topCategories,
        hotspotFiles,
        sampleErrors,
      });
      return res.json({ recommendations });
    } catch (err) {
      return res.status(502).json({
        error: `Gemini recommendations failed: ${err instanceof Error ? err.message : 'Upstream API error'}`,
      });
    }
  });

  app.get('/api/intelligence/learning', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (projectId) {
      clauses.push('l.project_id = ?');
      params.push(projectId);
    }
    if (category && category !== 'all') {
      clauses.push('l.category = ?');
      params.push(category);
    }
    if (q) {
      clauses.push('(l.title LIKE ? OR l.root_cause LIKE ? OR l.why_it_works LIKE ? OR l.error_message LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT l.*, p.name as project_name FROM bug_learning_records l JOIN projects p ON p.id = l.project_id ${whereSql} ORDER BY l.created_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return res.json({
      records: rows.map((r) => ({
        ...r,
        concepts: JSON.parse(String(r.concepts_json || '[]')),
      })),
    });
  });

  // ==================== WEBSITE DEBUGGER ====================
  app.post('/api/website-debugger/scan', async (req, res) => {
    const schema = z.object({
      url: z.string().min(4).max(2048),
      projectId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Please provide a valid URL.' });

    const { url, projectId } = parsed.data;
    const projectFiles = projectId
      ? (db.prepare('SELECT relative_path as relativePath, content FROM uploaded_files WHERE project_id = ?').all(projectId) as Array<{
          relativePath: string;
          content: string;
        }>)
      : [];

    const scanId = newId('web');
    try {
      const report = await runWebsiteDebuggerScan(url, {
        projectFiles,
        onProgress: (stage, detail) => {
          io.emit('website:progress', { scanId, url, stage, detail });
        },
      });

      db.prepare(
        `INSERT INTO website_scan_results (id, project_id, user_id, url, final_url, status, http_status, load_time_ms, issues_json, metrics_json, summary_json)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
      ).run(
        scanId,
        projectId ?? null,
        req.user!.userId,
        report.url,
        report.finalUrl,
        report.httpStatus,
        report.loadTimeMs,
        JSON.stringify(report.issues),
        JSON.stringify(report.metrics),
        JSON.stringify(report.summary),
      );

      if (report.summary.critical > 0 || report.summary.high > 0) {
        io.emit('bug:detected', {
          projectId: projectId ?? null,
          projectName: report.finalUrl,
          scanId,
          count: report.summary.totalIssues,
          criticalCount: report.summary.critical,
          severity: report.summary.critical > 0 ? 'critical' : 'high',
        });
      }

      emitNotification({
        userId: req.user!.userId,
        projectId: projectId ?? null,
        type: 'scan_completed',
        severity: report.summary.critical > 0 ? 'critical' : report.summary.totalIssues > 0 ? 'warning' : 'success',
        title: `Website scan finished: ${new URL(report.finalUrl).hostname}`,
        message: `HTTP ${report.httpStatus} · ${report.loadTimeMs}ms · ${report.summary.totalIssues} issue(s) found (Score ${report.summary.score}/100).`,
        targetRoute: '/website-debugger',
      });

      return res.json({ id: scanId, ...report });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Website scan failed.';
      db.prepare(
        `INSERT INTO website_scan_results (id, project_id, user_id, url, final_url, status, error_message)
         VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
      ).run(scanId, projectId ?? null, req.user!.userId, url, url, msg);

      return res.status(400).json({ error: msg, id: scanId });
    }
  });

  app.get('/api/website-debugger/history', (_req, res) => {
    const rows = db.prepare('SELECT * FROM website_scan_results ORDER BY created_at DESC LIMIT 20').all() as Array<
      Record<string, unknown>
    >;
    return res.json({
      scans: rows.map((r) => ({
        ...r,
        issues: JSON.parse(String(r.issues_json || '[]')),
        metrics: JSON.parse(String(r.metrics_json || '{}')),
        summary: JSON.parse(String(r.summary_json || '{}')),
      })),
    });
  });

  // ==================== MULTIMEDIA BUG DETECTOR ====================
  app.post('/api/multimedia/analyze', mediaUpload.single('media'), async (req, res) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Please upload an image, audio, or video file.' });
    }
    const projectId = typeof req.body?.projectId === 'string' && req.body.projectId ? req.body.projectId : null;

    try {
      const report = await inspectMultimediaFile({
        filePath: file.path,
        originalName: file.originalname,
        mimeType: file.mimetype || 'application/octet-stream',
      });

      const id = newId('med');
      db.prepare(
        `INSERT INTO multimedia_analysis (
          id, project_id, user_id, file_name, media_type, mime_type, stored_path, file_size,
          format, codec, duration_sec, width, height, bitrate, validation_status,
          problems_json, metadata_json, browser_preview_supported
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        projectId,
        req.user!.userId,
        report.fileName,
        report.mediaType,
        report.mimeType,
        file.filename,
        report.fileSize,
        report.format,
        report.codec,
        report.durationSec,
        report.width,
        report.height,
        report.bitrate,
        report.validationStatus,
        JSON.stringify(report.problems),
        JSON.stringify(report.metadata),
        report.browserPreviewSupported ? 1 : 0,
      );

      if (report.validationStatus === 'corrupted' || report.validationStatus === 'unsupported') {
        io.emit('bug:detected', {
          projectId,
          projectName: report.fileName,
          count: report.problems.length,
          criticalCount: report.problems.filter((p) => p.severity === 'critical').length,
          severity: report.validationStatus === 'corrupted' ? 'critical' : 'high',
        });
      }

      emitNotification({
        userId: req.user!.userId,
        projectId,
        type: report.validationStatus === 'valid' ? 'scan_completed' : 'bugs_detected',
        severity: report.validationStatus === 'corrupted' ? 'critical' : report.validationStatus === 'valid' ? 'success' : 'warning',
        title: `Multimedia inspection: ${report.fileName}`,
        message: `Status: ${report.validationStatus.toUpperCase()} · ${report.format}/${report.codec} · ${report.problems.length} issue(s).`,
        targetRoute: '/multimedia-debugger',
      });

      return res.status(201).json({
        analysis: {
          id,
          ...report,
          previewUrl: report.browserPreviewSupported ? `/api/multimedia/${id}/preview` : null,
          created_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      fs.rmSync(file.path, { force: true });
      return res.status(500).json({ error: err instanceof Error ? err.message : 'Multimedia inspection failed.' });
    }
  });

  app.get('/api/multimedia/history', (_req, res) => {
    const rows = db.prepare('SELECT * FROM multimedia_analysis ORDER BY created_at DESC LIMIT 25').all() as Array<
      Record<string, unknown>
    >;
    return res.json({
      analyses: rows.map((r) => ({
        ...r,
        problems: JSON.parse(String(r.problems_json || '[]')),
        metadata: JSON.parse(String(r.metadata_json || '{}')),
        browserPreviewSupported: Boolean(r.browser_preview_supported),
        previewUrl: r.browser_preview_supported ? `/api/multimedia/${r.id}/preview` : null,
      })),
    });
  });

  app.get('/api/multimedia/project-refs', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!projectId) return res.json({ references: [] });
    const files = db
      .prepare('SELECT relative_path as relativePath, content FROM uploaded_files WHERE project_id = ?')
      .all(projectId) as Array<{ relativePath: string; content: string }>;
    return res.json({ references: scanProjectMediaReferences(files) });
  });

  app.get('/api/multimedia/:id/preview', (req, res) => {
    const row = db
      .prepare('SELECT stored_path, mime_type, media_type, browser_preview_supported FROM multimedia_analysis WHERE id = ?')
      .get(req.params.id) as
      | { stored_path: string; mime_type: string; media_type: string; browser_preview_supported: number }
      | undefined;
    if (!row || !row.browser_preview_supported) {
      return res.status(404).json({ error: 'Preview unavailable for this media file.' });
    }
    const fullPath = path.resolve(mediaStorageDir, path.basename(row.stored_path));
    if (!fullPath.startsWith(mediaStorageDir) || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Media file not found on disk.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    return res.sendFile(fullPath);
  });

  // ==================== PATCH AUDIT TRAIL & CSV EXPORT ====================
  app.get('/api/audit', (req, res) => {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (req.query.projectId && req.query.projectId !== 'all') {
      clauses.push('project_id = ?');
      params.push(String(req.query.projectId));
    }
    if (req.query.actionType && req.query.actionType !== 'all') {
      clauses.push('action_type = ?');
      params.push(String(req.query.actionType));
    }
    if (req.query.riskLevel && req.query.riskLevel !== 'all') {
      clauses.push('risk_level = ?');
      params.push(String(req.query.riskLevel));
    }
    if (req.query.bugCategory && req.query.bugCategory !== 'all') {
      clauses.push('bug_category = ?');
      params.push(String(req.query.bugCategory));
    }
    if (req.query.user && req.query.user !== 'all') {
      clauses.push('user_name = ?');
      params.push(String(req.query.user));
    }
    if (req.query.dateFrom) {
      clauses.push('created_at >= ?');
      params.push(String(req.query.dateFrom));
    }
    if (req.query.dateTo) {
      clauses.push('created_at <= ?');
      params.push(`${String(req.query.dateTo)}T23:59:59.999Z`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const events = db
      .prepare(`SELECT * FROM patch_audit_events ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...params);
    return res.json({ events });
  });

  app.get('/api/audit/export.csv', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId !== 'all' ? req.query.projectId : null;
    const rows = (projectId
      ? db.prepare('SELECT * FROM patch_audit_events WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
      : db.prepare('SELECT * FROM patch_audit_events ORDER BY created_at DESC').all()) as Array<Record<string, unknown>>;

    const escapeCsv = (val: unknown) => `"${String(val ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const headers = [
      'Event ID',
      'Timestamp',
      'User',
      'Project',
      'File',
      'Bug Category',
      'Action Type',
      'Status',
      'Risk Level',
      'Confidence Score',
      'Risk Score',
      'Validation Result',
      'Details',
    ];
    const lines = [
      headers.join(','),
      ...rows.map((r) =>
        [
          r.id,
          r.created_at,
          r.user_name,
          r.project_name,
          r.file_path,
          r.bug_category,
          r.action_type,
          r.action_status,
          r.risk_level,
          r.confidence_score ?? '',
          r.risk_score ?? '',
          r.validation_result,
          r.details,
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="autopatch-audit-trail.csv"');
    return res.send(lines.join('\n'));
  });

  // ==================== NOTIFICATIONS ====================
  app.get('/api/notifications', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' && req.query.projectId !== 'all' ? req.query.projectId : null;
    const rows = (projectId
      ? db
          .prepare('SELECT * FROM notifications WHERE user_id = ? AND (project_id = ? OR project_id IS NULL) ORDER BY created_at DESC LIMIT 60')
          .all(req.user!.userId, projectId)
      : db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 60').all(req.user!.userId)) as Array<
      Record<string, unknown>
    >;

    const unreadCount = (
      db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user!.userId) as { c: number }
    ).c;

    return res.json({
      notifications: rows.map((r) => ({ ...r, metadata: JSON.parse(String(r.metadata_json || '{}')) })),
      unreadCount,
    });
  });

  app.patch('/api/notifications/:id/read', (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.userId);
    const unreadCount = (
      db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user!.userId) as { c: number }
    ).c;
    return res.json({ updated: true, unreadCount });
  });

  app.post('/api/notifications/read-all', (req, res) => {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user!.userId);
    return res.json({ updated: true, unreadCount: 0 });
  });

  // Global API error handler (never leaks stack traces)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      const msg = err instanceof Error ? err.message : 'Internal server error.';
      return res.status(500).json({ error: msg });
    }
    next(err);
  });

  // ==================== FRONTEND SERVING (VITE DEV / DIST PROD) ====================
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`AutoPatch AI server running on http://0.0.0.0:${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start AutoPatch AI server:', err);
  process.exit(1);
});
