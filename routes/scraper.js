require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { param, validationResult } = require('express-validator');
const { getRows, getConfig } = require('../config/db-helpers');
const { runQuery } = require('../config/db-helpers');
const { fetchRssSource } = require('../services/scraper');
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

// Los logs del scraper se comparten desde server.js via app.locals
const runScrapingProcess = async (app, draftOnly, sourceToScrape = null) => {
    const addLog = app.locals.addLog;
    addLog(`Iniciando scraper (${sourceToScrape ? sourceToScrape.name : 'todas'}, modo: ${draftOnly ? 'borrador' : 'auto'})`, 'info');

    const config = await getConfig();
    const activeSources = sourceToScrape
        ? [sourceToScrape]
        : await getRows('SELECT * FROM sources WHERE active = 1');
    const maxArticles = config.maxArticlesPerRun || 10;
    const articlesPerSource = Math.min(parseInt(config.articlesPerSource) || 2, maxArticles);
    const author = config.defaultAuthor || 'Redacción';

    let newArticlesCount = 0;
    addLog(`Procesando ${activeSources.length} fuentes`, 'info');

    for (let source of activeSources) {
        addLog(`[Fuente] Extrayendo de: ${source.name}...`, 'info');
        const articles = await fetchRssSource(source, articlesPerSource);
        addLog(`[Fuente] Encontrados ${articles.length} artículos en ${source.name}`, 'success');

        for (let art of articles) {
            try {
                if (art.original_url) {
                    const exists = await getRows(
                        'SELECT id FROM articles WHERE original_url = ?',
                        [art.original_url]
                    );
                    if (exists && exists.length > 0) {
                        addLog(`[Saltado] Ya existe: ${art.title.substring(0, 30)}...`, 'info');
                        continue;
                    }
                }

                let processedArt = { ...art };
                const canRewrite = config.aiProvider && (config.openaiKey || config.geminiKey || config.openrouterKey);

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
                    [
                        processedArt.categoryId,
                        processedArt.slug,
                        processedArt.title,
                        processedArt.meta,
                        processedArt.image,
                        processedArt.body,
                        new Date().toISOString(),
                        status,
                        author,
                        processedArt.original_url || ''
                    ]
                );
                newArticlesCount++;
                addLog(`[OK] Guardado: ${processedArt.title.substring(0, 30)}...`, 'success');
            } catch (e) {
                addLog(`[Error] en ${art.title.substring(0, 30)}: ${e.message}`, 'error');
            }
        }
    }

    addLog(`Scraper finalizado. Total nuevos: ${newArticlesCount} artículos`, 'success');
    return newArticlesCount;
};

// POST /api/scrape - Ejecutar scraper en todas las fuentes
router.post('/', auth, async (req, res) => {
    try {
        const { draftOnly } = req.body;
        const count = await runScrapingProcess(req.app, !!draftOnly);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: 'Error en el proceso de scraping' });
    }
});

// POST /api/scrape/:id - Ejecutar scraper en una fuente especifica
router.post('/:id', auth, [
    param('id').isInt({ min: 1 }).toInt()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'ID de fuente inválido' });
    }

    try {
        const sources = await getRows('SELECT * FROM sources WHERE id = ?', [req.params.id]);
        const source = sources[0];
        if (!source) return res.status(404).json({ error: 'Fuente no encontrada' });
        const count = await runScrapingProcess(req.app, false, source);
        res.json({ success: true, count });
    } catch (e) {
        res.status(500).json({ error: 'Error en el proceso de scraping' });
    }
});

module.exports = { router, runScrapingProcess };
