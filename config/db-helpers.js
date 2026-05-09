const db = require('../database/db');

const getRows = (query, params = []) =>
    new Promise((resolve, reject) =>
        db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows))
    );

const getRow = (query, params = []) =>
    new Promise((resolve, reject) =>
        db.get(query, params, (err, row) => err ? reject(err) : resolve(row))
    );

const runQuery = (query, params = []) =>
    new Promise((resolve, reject) =>
        db.run(query, params, function(err) { err ? reject(err) : resolve(this); })
    );

async function getConfig() {
    const configRows = await getRows('SELECT * FROM config');
    const config = {};
    configRows.forEach(row => {
        const numericKeys = ['autoPublish', 'extractImage', 'maxArticlesPerRun', 'articlesPerSource', 'scraperInterval', 'enableAI', 'tickerSpeed'];
        config[row.key] = numericKeys.includes(row.key) ? Number(row.value) : row.value;
        if (row.key === 'autoPublish' || row.key === 'extractImage' || row.key === 'enableAI') {
            config[row.key] = config[row.key] === 1;
        }
    });
    // Defaults
    if (config.enableAI === undefined) config.enableAI = true;
    if (config.autoPublish === undefined) config.autoPublish = true;
    return config;
}

async function getFullState() {
    const config = await getConfig();
    const categories = await getRows('SELECT * FROM categories');
    categories.forEach(c => c.active = c.active !== 0);
    const sources = await getRows('SELECT * FROM sources');
    sources.forEach(s => s.active = s.active === 1);
    const schedules = await getRows('SELECT * FROM schedules');
    schedules.forEach(s => s.active = s.active === 1);
    const articles = await getRows('SELECT * FROM articles ORDER BY id DESC');
    return { config, categories, sources, schedules, articles };
}

const SENSITIVE_KEYS = ['openaiKey', 'geminiKey', 'openrouterKey'];

function sanitizeConfig(config) {
    const safe = {};
    for (const k of Object.keys(config)) {
        if (!SENSITIVE_KEYS.includes(k)) {
            safe[k] = config[k];
        }
    }
    safe.hasAiConfigured = !!(config.openaiKey || config.geminiKey || config.openrouterKey);
    return safe;
}

async function getPublicState() {
    const state = await getFullState();
    state.config = sanitizeConfig(state.config);
    state.articles = state.articles.filter(a => a.status === 'published');
    try { state.ads = await getRows('SELECT * FROM ads WHERE active = 1'); } catch(e) { state.ads = []; }
    try {
        const polls = await getRows('SELECT * FROM polls WHERE active = 1 ORDER BY id DESC');
        for (const p of polls) {
            p.options = await getRows(
                `SELECT po.*, (SELECT COUNT(*) FROM poll_votes pv WHERE pv.option_id = po.id) AS votes
                 FROM poll_options po WHERE po.poll_id = ? ORDER BY po.sort_order, po.id`, [p.id]
            );
            p.total_votes = p.options.reduce((s, o) => s + (o.votes || 0), 0);
        }
        state.polls = polls;
    } catch(e) { state.polls = []; }
    return state;
}

async function getAdminState() {
    const state = await getFullState();
    const cfg = state.config;
    SENSITIVE_KEYS.forEach(k => {
        if (cfg[k] && cfg[k].length > 8) {
            cfg['_' + k] = cfg[k];
            cfg[k] = cfg[k].substring(0, 4) + '...' + cfg[k].slice(-4);
        }
    });
    return state;
}

module.exports = { getRows, getRow, runQuery, getConfig, getFullState, getPublicState, getAdminState, sanitizeConfig };
