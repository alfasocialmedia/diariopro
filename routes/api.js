require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { body, query, param, validationResult } = require('express-validator');
const { getRows, getRow, runQuery, getConfig } = require('../config/db-helpers');
const { rewriteArticle } = require('../services/ai-rewriter');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const auth = (req, res, next) => {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Acceso denegado' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Token invalido o expirado' });
        req.user = user;
        next();
    });
};

// GET /api/articles - listado con paginacion y busqueda
router.get('/', [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('q').optional().trim().isLength({ max: 200 }),
    query('category').optional().isInt({ min: 1 }).toInt(),
    query('status').optional().isIn(['published', 'draft'])
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Parámetros de búsqueda inválidos' });
    }

    try {
        const page = req.query.page || 1;
        const limit = req.query.limit || 20;
        const offset = (page - 1) * limit;
        const search = req.query.q || '';
        const categoryId = req.query.category || null;
        const status = req.query.status || null;

        const whereConditions = [];
        const params = [];

        if (search) {
            whereConditions.push('(title LIKE ? OR meta LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        if (categoryId) {
            whereConditions.push('categoryId = ?');
            params.push(categoryId);
        }
        if (status) {
            whereConditions.push('status = ?');
            params.push(status);
        }

        const where = whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const [totalRow, articles] = await Promise.all([
            getRow(`SELECT COUNT(*) as total FROM articles ${where}`, params),
            getRows(
                `SELECT * FROM articles ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            )
        ]);

        res.json({
            articles,
            pagination: {
                total: totalRow.total,
                page,
                limit,
                pages: Math.ceil(totalRow.total / limit)
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Error al obtener artículos' });
    }
});

// POST /api/sync - sincronizar datos desde el panel admin
router.post('/sync', auth, [
    body('key').isIn(['config', 'categories', 'sources', 'schedules', 'articles']),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Datos de sincronización inválidos' });
    }

    try {
        const { key, data } = req.body;

        if (key === 'config') {
            for (let [k, v] of Object.entries(data)) {
                if (!/^[a-zA-Z0-9_]+$/.test(k)) continue;
                let valueToSave;
                if (typeof v === 'boolean') valueToSave = v ? '1' : '0';
                else if (typeof v === 'object' && v !== null) valueToSave = JSON.stringify(v);
                else valueToSave = String(v).slice(0, 5000);
                await runQuery('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [k, valueToSave]);
            }
        } else if (key === 'categories') {
            await runQuery('DELETE FROM categories');
            for (let c of data) {
                await runQuery(
                    'INSERT INTO categories (id, name, slug, color, active) VALUES (?, ?, ?, ?, ?)',
                    [
                        parseInt(c.id) || null,
                        String(c.name || '').slice(0, 100),
                        String(c.slug || '').replace(/[^a-z0-9-]/g, '').slice(0, 100),
                        String(c.color || '#000000').slice(0, 20),
                        c.active === false || c.active === 0 ? 0 : 1
                    ]
                );
            }
        } else if (key === 'sources') {
            await runQuery('DELETE FROM sources');
            for (let s of data) {
                await runQuery(
                    'INSERT INTO sources (id, name, url, categoryId, active, schedule) VALUES (?, ?, ?, ?, ?, ?)',
                    [
                        parseInt(s.id) || null,
                        String(s.name || '').slice(0, 200),
                        String(s.url || '').slice(0, 500),
                        parseInt(s.categoryId) || null,
                        s.active ? 1 : 0,
                        String(s.schedule || '').slice(0, 10)
                    ]
                );
            }
        } else if (key === 'schedules') {
            await runQuery('DELETE FROM schedules');
            for (let s of data) {
                await runQuery(
                    'INSERT INTO schedules (id, time, label, active) VALUES (?, ?, ?, ?)',
                    [
                        parseInt(s.id) || null,
                        String(s.time || '').replace(/[^0-9:]/g, '').slice(0, 5),
                        String(s.label || '').slice(0, 100),
                        s.active ? 1 : 0
                    ]
                );
            }
        } else if (key === 'articles') {
            await runQuery('DELETE FROM articles');
            for (let a of data) {
                await runQuery(
                    'INSERT INTO articles (id, categoryId, slug, title, meta, image, body, date, status, source, original_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        parseInt(a.id) || null,
                        parseInt(a.categoryId) || null,
                        String(a.slug || '').slice(0, 200),
                        String(a.title || '').slice(0, 500),
                        String(a.meta || '').slice(0, 1000),
                        String(a.image || '').slice(0, 500),
                        String(a.body || ''),
                        String(a.date || '').slice(0, 30),
                        ['published', 'draft'].includes(a.status) ? a.status : 'draft',
                        String(a.source || '').slice(0, 200),
                        String(a.original_url || '').slice(0, 500)
                    ]
                );
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Error al sincronizar' });
    }
});

// POST /api/rewrite - reescribir articulo con IA
router.post('/rewrite', auth, [
    body('article').isObject(),
    body('article.title').isString().notEmpty().isLength({ max: 500 }),
    body('article.body').isString().notEmpty()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, error: 'Datos del artículo inválidos' });
    }

    try {
        const { article } = req.body;
        const config = await getConfig();
        const rewritten = await rewriteArticle(article, config);

        if (article.id) {
            const newSlug = rewritten.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .slice(0, 50) + '-' + Date.now();
            await runQuery(
                'UPDATE articles SET title = ?, meta = ?, body = ?, slug = ? WHERE id = ?',
                [rewritten.title, rewritten.meta, rewritten.body, newSlug, parseInt(article.id)]
            );
        }

        res.json({ success: true, article: rewritten });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Error en la reescritura' });
    }
});

module.exports = router;
