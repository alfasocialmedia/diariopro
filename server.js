require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const { query, body, param, validationResult } = require('express-validator');

const { corsOptions, helmetOptions, apiLimiter } = require('./config/middleware');
const { getRows, getRow, runQuery, getConfig, getFullState, getPublicState, getAdminState } = require('./config/db-helpers');
const { fetchRssSource } = require('./services/scraper');
const { rewriteArticle } = require('./services/ai-rewriter');
const authRouter = require('./routes/auth');

// ─── Logs en memoria ─────────────────────────────────────────────────────────
const SCRAPER_LOGS = [];
function addLog(msg, type = 'info') {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    SCRAPER_LOGS.unshift(entry);
    if (SCRAPER_LOGS.length > 100) SCRAPER_LOGS.pop();
}

// ─── Proceso de scraping ──────────────────────────────────────────────────────
const runScrapingProcess = async (draftOnly, sourceToScrape = null) => {
    addLog(`Iniciando scraper (${sourceToScrape ? sourceToScrape.name : 'todas'}, modo: ${draftOnly ? 'borrador' : 'auto'})`, 'info');
    const config = await getConfig();
    const activeSources = sourceToScrape
        ? [sourceToScrape]
        : await getRows('SELECT * FROM sources WHERE active = 1');
    const maxArticles = parseInt(config.maxArticlesPerRun) || 10;
    const articlesPerSource = Math.min(parseInt(config.articlesPerSource) || 2, maxArticles);
    const author = config.defaultAuthor || 'Redacción';
    let newArticlesCount = 0;

    addLog(`Procesando ${activeSources.length} fuentes, ${articlesPerSource} artículo(s) c/u`, 'info');

    for (let source of activeSources) {
        addLog(`[Fuente] Extrayendo de: ${source.name}...`, 'info');
        const articles = await fetchRssSource(source, articlesPerSource);
        addLog(`[Fuente] Encontrados ${articles.length} artículos en ${source.name}`, 'success');

        for (let art of articles) {
            try {
                if (art.original_url) {
                    const exists = await getRows('SELECT id FROM articles WHERE original_url = ?', [art.original_url]);
                    if (exists && exists.length > 0) {
                        addLog(`[Saltado] Ya existe: ${art.title.substring(0, 30)}...`, 'info');
                        continue;
                    }
                }

                let processedArt = { ...art };
                const canRewrite = config.enableAI !== false && config.aiProvider && (config.openaiKey || config.geminiKey || config.openrouterKey);

                if (canRewrite) {
                    try {
                        addLog(`[IA] Procesando: ${art.title.substring(0, 30)}...`, 'info');
                        const rewritten = await rewriteArticle(art, config);
                        if (rewritten.title !== art.title) {
                            processedArt = { ...art, ...rewritten };
                            addLog(`[IA] Éxito: "${processedArt.title.substring(0, 30)}..."`, 'success');
                        } else {
                            addLog('[IA] Advertencia: misma respuesta. Usando original.', 'warning');
                        }
                    } catch (iaError) {
                        addLog(`[IA Error] Falló reescritura: ${iaError.message}`, 'error');
                    }
                } else {
                    addLog(`[IA] Saltado: sin API Key para ${config.aiProvider || 'ningún proveedor'}.`, 'warning');
                }

                processedArt.slug = processedArt.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .slice(0, 50) + '-' + Date.now();

                const status = (config.autoPublish && !draftOnly) ? 'published' : 'draft';
                await runQuery(
                    'INSERT INTO articles (categoryId, slug, title, meta, image, body, date, status, source, original_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [processedArt.categoryId, processedArt.slug, processedArt.title, processedArt.meta,
                     processedArt.image, processedArt.body, new Date().toISOString(), status, author, processedArt.original_url || '']
                );
                newArticlesCount++;
                addLog(`[OK] Guardado: ${processedArt.title.substring(0, 30)}...`, 'success');
            } catch (e) {
                addLog(`[Error] en ${art.title.substring(0, 30)}: ${e.message}`, 'error');
            }
        }
    }

    addLog(`Scraper finalizado. Nuevos: ${newArticlesCount} artículos`, 'success');
    return newArticlesCount;
};

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();

// Seguridad y parsers
app.use(helmet(helmetOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.disable('x-powered-by');
app.set('etag', false); // Deshabilitar ETag globalmente

// Sin caché (desarrollo)
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Rate limiting en API
app.use('/api', apiLimiter);

// JWT auth middleware
const JWT_SECRET = process.env.JWT_SECRET;
const auth = (req, res, next) => {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Acceso denegado' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
        req.user = user;
        next();
    });
};

// ─── OG Tags helper ───────────────────────────────────────────────────────────
function escAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildOgTags(title, description, image, url, siteName, type) {
    type = type || 'website';
    return [
        `<meta name="description" content="${escAttr(description)}">`,
        `<meta property="og:type" content="${type}">`,
        `<meta property="og:site_name" content="${escAttr(siteName)}">`,
        `<meta property="og:title" content="${escAttr(title)}">`,
        `<meta property="og:description" content="${escAttr(description)}">`,
        `<meta property="og:image" content="${escAttr(image)}">`,
        `<meta property="og:url" content="${escAttr(url)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${escAttr(title)}">`,
        `<meta name="twitter:description" content="${escAttr(description)}">`,
        `<meta name="twitter:image" content="${escAttr(image)}">`
    ].join('\n    ');
}

function injectOgAndState(html, state, ogParams) {
    const cfg = state.config || {};
    const siteName = cfg.siteName || 'DiarioPro';
    const siteUrl = (cfg.siteUrl || '').replace(/\/$/, '');
    const title = ogParams.title || siteName;
    const description = ogParams.description || cfg.seoDescription || '';
    const image = ogParams.image || cfg.seoImage || '';
    const url = ogParams.url || siteUrl + '/';

    const ogTags = buildOgTags(title, description, image, url, siteName, ogParams.type);

    return html
        .replace('<title>DiarioPro - Diario Digital & Radio en Vivo</title>', `<title>${escAttr(title)}</title>`)
        .replace('<!-- __OG_TAGS__ -->', ogTags)
        .replace('</head>', `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script></head>`);
}

// ─── Páginas HTML ─────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
    try {
        const state = await getPublicState();
        const cfg = state.config || {};
        const siteName = cfg.siteName || 'DiarioPro';
        const siteUrl = (cfg.siteUrl || '').replace(/\/$/, '');
        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        html = injectOgAndState(html, state, {
            title: siteName + (cfg.siteTagline ? ' - ' + cfg.siteTagline : ' - Diario Digital & Radio en Vivo'),
            description: cfg.seoDescription || '',
            image: cfg.seoImage || '',
            url: siteUrl + '/'
        });
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e) {
        console.error('Error sirviendo index:', e.message);
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Ruta para compartir artículos — genera OG tags con datos del artículo
app.get('/n/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 200);
        const [state, article] = await Promise.all([
            getPublicState(),
            getRow('SELECT * FROM articles WHERE slug = ? AND status = ?', [slug, 'published'])
        ]);
        const cfg = state.config || {};
        const siteName = cfg.siteName || 'DiarioPro';
        const siteUrl = (cfg.siteUrl || '').replace(/\/$/, '');
        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        const ogParams = article
            ? { title: article.title + ' - ' + siteName, description: article.meta || '', image: article.image || cfg.seoImage || '', url: siteUrl + '/n/' + slug, type: 'article' }
            : { title: siteName, description: cfg.seoDescription || '', image: cfg.seoImage || '', url: siteUrl + '/' };
        html = injectOgAndState(html, state, ogParams);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e) {
        console.error('Error sirviendo artículo:', e.message);
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.get(['/admin', '/admin.html'], async (req, res) => {
    try {
        const state = await getAdminState();
        let html = fs.readFileSync(path.join(__dirname, 'public', 'admin.html'), 'utf8');
        html = html.replace('</head>', `<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script></head>`);
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (e) {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    }
});

app.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
}));

// ─── API - Rutas públicas ─────────────────────────────────────────────────────

// Login (con rate limiting propio en authRouter)
app.use('/api', authRouter);

// Estado completo
app.get('/api/state', async (req, res) => {
    try {
        res.json(await getPublicState());
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener estado' });
    }
});

// Artículos con paginación y búsqueda
app.get('/api/articles', [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('q').optional().trim().isLength({ max: 200 }),
    query('category').optional().isInt({ min: 1 }).toInt(),
    query('status').optional().isIn(['published', 'draft'])
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros inválidos' });

    try {
        const page = req.query.page || 1;
        const limit = req.query.limit || 20;
        const offset = (page - 1) * limit;
        const search = req.query.q || '';
        const categoryId = req.query.category || null;
        const status = req.query.status || null;

        const conds = [];
        const params = [];
        if (search) { conds.push('(title LIKE ? OR meta LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
        if (categoryId) { conds.push('categoryId = ?'); params.push(categoryId); }
        if (status) { conds.push('status = ?'); params.push(status); }

        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const [totalRow, articles] = await Promise.all([
            getRow(`SELECT COUNT(*) as total FROM articles ${where}`, params),
            getRows(`SELECT * FROM articles ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset])
        ]);

        res.json({
            articles,
            pagination: { total: totalRow.total, page, limit, pages: Math.ceil(totalRow.total / limit) }
        });
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener artículos' });
    }
});

// ─── API - Rutas protegidas (requieren JWT) ───────────────────────────────────

// Logs del scraper
app.get('/api/logs', auth, (req, res) => {
    res.json(SCRAPER_LOGS);
});

// Sincronizar contraseña de admin
app.post('/api/change-password', auth, [
    body('newPassword').isString().isLength({ min: 10 }).matches(/[A-Z]/).withMessage('Debe tener al menos una mayuscula').matches(/[0-9]/).withMessage('Debe tener al menos un numero')
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'La contrasena debe tener al menos 10 caracteres, una mayuscula y un numero' });
    
    try {
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        
        if (envContent.includes('ADMIN_PASSWORD=')) {
            envContent = envContent.replace(/ADMIN_PASSWORD=.*/g, `ADMIN_PASSWORD=${req.body.newPassword}`);
        } else {
            envContent += `\nADMIN_PASSWORD=${req.body.newPassword}\n`;
        }
        
        fs.writeFileSync(envPath, envContent);
        process.env.ADMIN_PASSWORD = req.body.newPassword;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error interno guardando la contraseña' });
    }
});

// Sincronizar datos desde el admin
app.post('/api/sync', auth, [
    body('key').isIn(['config', 'categories', 'sources', 'schedules', 'articles'])
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Clave de sincronización inválida' });

    try {
        const { key, data } = req.body;

        if (key === 'config') {
            for (let [k, v] of Object.entries(data)) {
                if (!/^[a-zA-Z0-9_]+$/.test(k)) continue;
                let val = typeof v === 'boolean' ? (v ? '1' : '0')
                        : (typeof v === 'object' && v !== null) ? JSON.stringify(v)
                        : String(v).slice(0, 5000);
                await runQuery('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [k, val]);
            }
            // Reiniciar intervalo automático si cambió scraperInterval
            const updatedCfg = await getConfig();
            startAutoScrapeInterval(updatedCfg.scraperInterval || 0);
        } else if (key === 'categories') {
            await runQuery('DELETE FROM categories');
            for (let c of data) {
                await runQuery('INSERT INTO categories (id, name, slug, color, active) VALUES (?, ?, ?, ?, ?)',
                    [parseInt(c.id) || null, String(c.name || '').slice(0, 100),
                     String(c.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 100),
                     String(c.color || '#000000').slice(0, 20),
                     c.active === false || c.active === 0 ? 0 : 1]);
            }
        } else if (key === 'sources') {
            await runQuery('DELETE FROM sources');
            for (let s of data) {
                await runQuery('INSERT INTO sources (id, name, url, categoryId, active, schedule) VALUES (?, ?, ?, ?, ?, ?)',
                    [parseInt(s.id) || null, String(s.name || '').slice(0, 200),
                     String(s.url || '').slice(0, 500), parseInt(s.categoryId) || null,
                     s.active ? 1 : 0, String(s.schedule || '').slice(0, 10)]);
            }
        } else if (key === 'schedules') {
            await runQuery('DELETE FROM schedules');
            for (let s of data) {
                await runQuery('INSERT INTO schedules (id, time, label, active) VALUES (?, ?, ?, ?)',
                    [parseInt(s.id) || null, String(s.time || '').replace(/[^0-9:]/g, '').slice(0, 5),
                     String(s.label || '').slice(0, 100), s.active ? 1 : 0]);
            }
        } else if (key === 'articles') {
            await runQuery('DELETE FROM articles');
            for (let a of data) {
                await runQuery(
                    'INSERT INTO articles (id, categoryId, slug, title, meta, image, body, date, status, source, original_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [parseInt(a.id) || null, parseInt(a.categoryId) || null,
                     String(a.slug || '').slice(0, 200), String(a.title || '').slice(0, 500),
                     String(a.meta || '').slice(0, 1000), String(a.image || '').slice(0, 500),
                     String(a.body || ''), String(a.date || '').slice(0, 30),
                     ['published', 'draft'].includes(a.status) ? a.status : 'draft',
                     String(a.source || '').slice(0, 200), String(a.original_url || '').slice(0, 500)]
                );
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error interno al sincronizar' });
    }
});

// Reescribir artículo con IA
app.post('/api/rewrite', auth, [
    body('article').isObject(),
    body('article.title').isString().notEmpty().isLength({ max: 500 }),
    body('article.body').isString().notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: 'Datos del artículo inválidos' });

    try {
        const { article } = req.body;
        const config = await getConfig();
        const rewritten = await rewriteArticle(article, config);

        if (article.id) {
            const newSlug = rewritten.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + Date.now();
            await runQuery('UPDATE articles SET title = ?, meta = ?, body = ?, slug = ? WHERE id = ?',
                [rewritten.title, rewritten.meta, rewritten.body, newSlug, parseInt(article.id)]);
        }

        res.json({ success: true, article: rewritten });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Error en la reescritura' });
    }
});

// Ejecutar scraper (todas las fuentes)
app.post('/api/scrape', auth, async (req, res) => {
    try {
        const { draftOnly } = req.body;
        const count = await runScrapingProcess(!!draftOnly);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: 'Error en el proceso de scraping' });
    }
});

// Ejecutar scraper (fuente especifica)
app.post('/api/scrape/:id', auth, [
    param('id').isInt({ min: 1 }).toInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID de fuente inválido' });

    try {
        const sources = await getRows('SELECT * FROM sources WHERE id = ?', [req.params.id]);
        if (!sources[0]) return res.status(404).json({ error: 'Fuente no encontrada' });
        const count = await runScrapingProcess(false, sources[0]);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: 'Error en el proceso de scraping' });
    }
});

// Eliminar artículos duplicados — debe ir ANTES de /:id para evitar conflicto de ruta
app.delete('/api/articles/dedup', auth, async (req, res) => {
    try {
        const result = await runQuery(`
            DELETE FROM articles
            WHERE id NOT IN (
                SELECT MIN(id) FROM articles
                WHERE original_url IS NOT NULL AND original_url != ''
                GROUP BY original_url
            )
            AND original_url IS NOT NULL AND original_url != ''
        `);
        res.json({ success: true, deleted: result.changes });
    } catch (e) {
        res.status(500).json({ error: 'Error al eliminar duplicados' });
    }
});

// Eliminar artículo individual
app.delete('/api/articles/:id', auth, [
    param('id').isInt({ min: 1 }).toInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        await runQuery('DELETE FROM articles WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al eliminar articulo' });
    }
});

// ─── Encuestas ────────────────────────────────────────────────────────────────

const pollsUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'public', 'uploads', 'polls');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, 'poll-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + ext);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo imágenes'));
    }
});

function voterHash(req) {
    return crypto.createHash('sha256')
        .update((req.ip || '') + (req.headers['user-agent'] || ''))
        .digest('hex').slice(0, 20);
}

async function getPollWithOptions(pollId) {
    const poll = await getRow('SELECT * FROM polls WHERE id = ?', [pollId]);
    if (!poll) return null;
    poll.options = await getRows(
        `SELECT po.*, (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) AS votes
         FROM poll_options po WHERE po.poll_id = ? ORDER BY po.sort_order, po.id`,
        [pollId]
    );
    poll.total_votes = poll.options.reduce((s, o) => s + (o.votes || 0), 0);
    return poll;
}

// Encuestas públicas activas (con opciones y votos)
app.get('/api/polls/public', async (req, res) => {
    try {
        const polls = await getRows('SELECT * FROM polls WHERE active = 1 ORDER BY id DESC');
        for (const p of polls) {
            p.options = await getRows(
                `SELECT po.*, (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) AS votes
                 FROM poll_options po WHERE po.poll_id = ? ORDER BY po.sort_order, po.id`, [p.id]
            );
            p.total_votes = p.options.reduce((s, o) => s + (o.votes || 0), 0);
        }
        res.json(polls);
    } catch (e) { res.status(500).json({ error: 'Error al obtener encuestas' }); }
});

// Votar (público)
app.post('/api/polls/:id/vote', [
    param('id').isInt({ min: 1 }).toInt(),
    body('option_id').isInt({ min: 1 }).toInt()
], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });
    try {
        const { id } = req.params;
        const { option_id } = req.body;
        const hash = voterHash(req);
        const poll = await getRow('SELECT * FROM polls WHERE id = ? AND active = 1', [id]);
        if (!poll) return res.status(404).json({ error: 'Encuesta no encontrada o inactiva' });
        if (poll.ends_at && new Date(poll.ends_at) < new Date()) return res.status(400).json({ error: 'La encuesta ha finalizado' });
        const existing = await getRow('SELECT id FROM poll_votes WHERE poll_id = ? AND voter_hash = ?', [id, hash]);
        if (existing) return res.status(400).json({ error: 'ya_votaste' });
        const option = await getRow('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?', [option_id, id]);
        if (!option) return res.status(400).json({ error: 'Opción inválida' });
        await runQuery('INSERT INTO poll_votes (poll_id, option_id, voter_hash, voted_at) VALUES (?,?,?,?)',
            [id, option_id, hash, new Date().toISOString()]);
        const updated = await getPollWithOptions(id);
        res.json({ success: true, options: updated.options, total_votes: updated.total_votes });
    } catch (e) { res.status(500).json({ error: 'Error al votar' }); }
});

// Encuestas (admin)
app.get('/api/polls', auth, async (req, res) => {
    try {
        const polls = await getRows('SELECT * FROM polls ORDER BY id DESC');
        for (const p of polls) {
            p.options = await getRows(
                `SELECT po.*, (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) AS votes
                 FROM poll_options po WHERE po.poll_id = ? ORDER BY po.sort_order, po.id`, [p.id]
            );
            p.total_votes = p.options.reduce((s, o) => s + (o.votes || 0), 0);
        }
        res.json(polls);
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// Crear encuesta con opciones
app.post('/api/polls', auth, async (req, res) => {
    try {
        const { question, description, show_results, active, ends_at, placement, article_paragraph_after, options } = req.body;
        if (!question || !Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'Se necesita pregunta y al menos 2 opciones' });
        const result = await runQuery(
            'INSERT INTO polls (question, description, show_results, active, ends_at, placement, article_paragraph_after, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [String(question).slice(0, 500), String(description || '').slice(0, 1000),
             parseInt(show_results) || 0, active ? 1 : 0, ends_at || null,
             String(placement || 'home_top').slice(0, 50), parseInt(article_paragraph_after) || 2,
             new Date().toISOString()]
        );
        const pollId = result.lastID;
        const optionIds = [];
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            const or = await runQuery('INSERT INTO poll_options (poll_id, text, sort_order) VALUES (?,?,?)',
                [pollId, String(opt.text || '').slice(0, 300), i]);
            optionIds.push({ id: or.lastID, text: opt.text });
        }
        res.json({ success: true, id: pollId, options: optionIds });
    } catch (e) { res.status(500).json({ error: 'Error al crear encuesta' }); }
});

// Actualizar encuesta
app.put('/api/polls/:id', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        const { question, description, show_results, active, ends_at, placement, article_paragraph_after, options } = req.body;
        await runQuery(
            'UPDATE polls SET question=?, description=?, show_results=?, active=?, ends_at=?, placement=?, article_paragraph_after=? WHERE id=?',
            [String(question || '').slice(0, 500), String(description || '').slice(0, 1000),
             parseInt(show_results) || 0, active ? 1 : 0, ends_at || null,
             String(placement || 'home_top').slice(0, 50), parseInt(article_paragraph_after) || 2, req.params.id]
        );
        if (Array.isArray(options)) {
            const existing = await getRows('SELECT id FROM poll_options WHERE poll_id = ?', [req.params.id]);
            const existingIds = existing.map(r => r.id);
            const incomingIds = options.filter(o => o.id).map(o => o.id);
            for (const eid of existingIds) {
                if (!incomingIds.includes(eid)) await runQuery('DELETE FROM poll_options WHERE id = ?', [eid]);
            }
            for (let i = 0; i < options.length; i++) {
                const opt = options[i];
                if (opt.id) {
                    await runQuery('UPDATE poll_options SET text=?, sort_order=? WHERE id=? AND poll_id=?',
                        [String(opt.text || '').slice(0, 300), i, opt.id, req.params.id]);
                } else {
                    await runQuery('INSERT INTO poll_options (poll_id, text, sort_order) VALUES (?,?,?)',
                        [req.params.id, String(opt.text || '').slice(0, 300), i]);
                }
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

// Subir imagen para opción
app.post('/api/polls/options/:id/image', auth, [param('id').isInt({ min: 1 }).toInt()], pollsUpload.single('image'), async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
    try {
        const url = '/uploads/polls/' + req.file.filename;
        await runQuery('UPDATE poll_options SET image=? WHERE id=?', [url, req.params.id]);
        res.json({ success: true, url });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// Eliminar imagen de opción
app.delete('/api/polls/options/:id/image', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        const opt = await getRow('SELECT image FROM poll_options WHERE id=?', [req.params.id]);
        if (opt && opt.image) {
            const fp = path.join(__dirname, 'public', opt.image);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        await runQuery('UPDATE poll_options SET image=NULL WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// Eliminar encuesta
app.delete('/api/polls/:id', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        const opts = await getRows('SELECT image FROM poll_options WHERE poll_id=?', [req.params.id]);
        for (const o of opts) {
            if (o.image) { const fp = path.join(__dirname, 'public', o.image); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
        }
        await runQuery('DELETE FROM poll_votes WHERE poll_id=?', [req.params.id]);
        await runQuery('DELETE FROM poll_options WHERE poll_id=?', [req.params.id]);
        await runQuery('DELETE FROM polls WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error al eliminar' }); }
});

// Resetear votos de una encuesta
app.post('/api/polls/:id/reset', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        await runQuery('DELETE FROM poll_votes WHERE poll_id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// ─── Anuncios ─────────────────────────────────────────────────────────────────

const adsUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'public', 'uploads', 'ads');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, 'ad-' + Date.now() + ext);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Solo se permiten imágenes'));
    }
});

// Obtener anuncios activos (público — usado por el frontend)
app.get('/api/ads/public', async (req, res) => {
    try {
        const ads = await getRows('SELECT * FROM ads WHERE active = 1 ORDER BY id DESC');
        res.json(ads);
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener anuncios' });
    }
});

// Listar todos los anuncios (admin)
app.get('/api/ads', auth, async (req, res) => {
    try {
        res.json(await getRows('SELECT * FROM ads ORDER BY id DESC'));
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener anuncios' });
    }
});

// Crear anuncio
app.post('/api/ads', auth, async (req, res) => {
    try {
        const { name, type, content, placement, paragraph_after, show_mobile, show_tablet, show_desktop, active } = req.body;
        if (!name || !type || !placement) return res.status(400).json({ error: 'Faltan campos obligatorios' });
        const result = await runQuery(
            'INSERT INTO ads (name, type, content, placement, paragraph_after, show_mobile, show_tablet, show_desktop, active, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [String(name).slice(0, 200), ['image', 'html'].includes(type) ? type : 'html',
             String(content || ''), String(placement).slice(0, 50),
             parseInt(paragraph_after) || 1, show_mobile ? 1 : 0, show_tablet ? 1 : 0,
             show_desktop ? 1 : 0, active !== false ? 1 : 0, new Date().toISOString()]
        );
        res.json({ success: true, id: result.lastID });
    } catch (e) {
        res.status(500).json({ error: 'Error al crear anuncio' });
    }
});

// Actualizar anuncio
app.put('/api/ads/:id', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        const { name, type, content, placement, paragraph_after, show_mobile, show_tablet, show_desktop, active } = req.body;
        await runQuery(
            'UPDATE ads SET name=?, type=?, content=?, placement=?, paragraph_after=?, show_mobile=?, show_tablet=?, show_desktop=?, active=? WHERE id=?',
            [String(name || '').slice(0, 200), ['image', 'html'].includes(type) ? type : 'html',
             String(content || ''), String(placement || '').slice(0, 50),
             parseInt(paragraph_after) || 1, show_mobile ? 1 : 0, show_tablet ? 1 : 0,
             show_desktop ? 1 : 0, active ? 1 : 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al actualizar anuncio' });
    }
});

// Subir imagen para un anuncio
app.post('/api/ads/:id/image', auth, [param('id').isInt({ min: 1 }).toInt()], adsUpload.single('image'), async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
    try {
        const imageUrl = '/uploads/ads/' + req.file.filename;
        await runQuery('UPDATE ads SET content=?, type=? WHERE id=?', [imageUrl, 'image', req.params.id]);
        res.json({ success: true, url: imageUrl });
    } catch (e) {
        res.status(500).json({ error: 'Error al guardar imagen' });
    }
});

// Eliminar anuncio
app.delete('/api/ads/:id', auth, [param('id').isInt({ min: 1 }).toInt()], async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'ID inválido' });
    try {
        const ad = await getRow('SELECT content, type FROM ads WHERE id=?', [req.params.id]);
        if (ad && ad.type === 'image' && ad.content && ad.content.startsWith('/uploads/ads/')) {
            const filePath = path.join(__dirname, 'public', ad.content);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        await runQuery('DELETE FROM ads WHERE id=?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al eliminar anuncio' });
    }
});

// ─── 404 y errores globales ───────────────────────────────────────────────────
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta no encontrada' });
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Error interno' });
    res.status(500).send('Error interno del servidor');
});

// ─── Intervalo automático dinámico ───────────────────────────────────────────
let autoScrapeTimer = null;

function startAutoScrapeInterval(hours) {
    if (autoScrapeTimer) { clearInterval(autoScrapeTimer); autoScrapeTimer = null; }
    const h = parseInt(hours) || 0;
    if (h > 0) {
        autoScrapeTimer = setInterval(() => {
            console.log(`[Auto] Ejecutando scraper automático (cada ${h}h)`);
            addLog(`[Auto] Ejecución automática (intervalo ${h}h)`, 'info');
            runScrapingProcess(false).catch(e => {
                console.error('[Auto] Error:', e.message);
                addLog(`[Auto] Error: ${e.message}`, 'error');
            });
        }, h * 60 * 60 * 1000);
        console.log(`[Auto] Intervalo configurado: cada ${h} hora(s)`);
        addLog(`[Auto] Scraper automático: cada ${h} hora(s)`, 'success');
    } else {
        console.log('[Auto] Intervalo automático desactivado');
    }
}

// ─── Cronjobs ─────────────────────────────────────────────────────────────────
const setupCron = async () => {
    const schedules = await getRows('SELECT * FROM schedules WHERE active = 1');
    schedules.forEach(s => {
        const [h, m] = s.time.split(':');
        if (!h || !m) return;
        cron.schedule(`${m} ${h} * * *`, async () => {
            console.log(`[Cron] Global: ${s.time}`);
            try { await runScrapingProcess(false); } catch (e) { console.error(e.message); }
        });
    });

    const sources = await getRows(
        "SELECT * FROM sources WHERE active = 1 AND schedule IS NOT NULL AND schedule != ''"
    );
    sources.forEach(source => {
        if (source.schedule.includes(':')) {
            const [h, m] = source.schedule.split(':');
            if (h && m) {
                cron.schedule(`${m} ${h} * * *`, async () => {
                    console.log(`[Cron] ${source.name}: ${source.schedule}`);
                    try { await runScrapingProcess(false, source); } catch (e) { console.error(e.message); }
                });
            }
        } else {
            const hours = parseInt(source.schedule);
            if (!isNaN(hours) && hours > 0) {
                cron.schedule(`0 */${hours} * * *`, async () => {
                    console.log(`[Cron] ${source.name}: cada ${hours}h`);
                    try { await runScrapingProcess(false, source); } catch (e) { console.error(e.message); }
                });
            }
        }
    });

    console.log(`[Cron] ${schedules.length} globales y ${sources.length} fuentes programadas`);
};

// ─── Inicio ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ENV = process.env.NODE_ENV || 'development';

app.listen(PORT, async () => {
    console.log(`[DiarioPro] http://localhost:${PORT} (${ENV})`);
    try { await setupCron(); } catch (e) { console.error('[Cron] Error:', e.message); }
    try {
        const cfg = await getConfig();
        startAutoScrapeInterval(cfg.scraperInterval || 0);
    } catch (e) { console.error('[Auto] Error al iniciar:', e.message); }
});
