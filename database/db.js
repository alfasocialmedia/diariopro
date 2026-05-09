const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// En Coolify/Docker: configurar DB_PATH=/data/diarionow.db + volumen persistente en /data
// En local: usa la ruta por defecto relativa al archivo
const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'diariopro.db');
const db = new sqlite3.Database(dbPath);

// WAL mode: mejor rendimiento con lecturas concurrentes (Docker/producción)
db.run('PRAGMA journal_mode=WAL');
db.run('PRAGMA synchronous=NORMAL');
db.run('PRAGMA cache_size=10000');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categoryId INTEGER,
        slug TEXT,
        title TEXT,
        meta TEXT,
        image TEXT,
        body TEXT,
        date TEXT,
        status TEXT,
        source TEXT,
        original_url TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        slug TEXT,
        color TEXT,
        active INTEGER DEFAULT 1
    )`);

    db.run(`ALTER TABLE categories ADD COLUMN active INTEGER DEFAULT 1`, () => {});
    db.run(`UPDATE categories SET active = 1 WHERE active IS NULL`, () => {});

    db.run(`CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT,
        categoryId INTEGER,
        active INTEGER,
        schedule TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT,
        label TEXT,
        active INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS polls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question TEXT,
        description TEXT,
        show_results INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        ends_at TEXT,
        placement TEXT DEFAULT 'home_top',
        article_paragraph_after INTEGER DEFAULT 2,
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS poll_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER,
        text TEXT,
        image TEXT,
        sort_order INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS poll_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id INTEGER,
        option_id INTEGER,
        voter_hash TEXT,
        voted_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT,
        content TEXT,
        placement TEXT,
        paragraph_after INTEGER DEFAULT 1,
        show_mobile INTEGER DEFAULT 1,
        show_tablet INTEGER DEFAULT 1,
        show_desktop INTEGER DEFAULT 1,
        active INTEGER DEFAULT 1,
        created_at TEXT
    )`);

    // Seed initial config if empty
    db.get("SELECT COUNT(*) as count FROM config", (err, row) => {
        if (row && row.count === 0) {
            const initialConfig = {
                siteName: 'DiarioPro',
                siteUrl: '',
                siteTagline: 'Diario Digital & Radio en Vivo',
                seoDescription: '',
                seoImage: '',
                radioStreamUrl: 'https://streams.ilovemusic.de/iloveradio17.mp3',
                radioName: 'Radio DiarioPro',
                aiProvider: 'openai',
                openaiKey: '',
                openaiModel: 'gpt-4o-mini',
                geminiKey: '',
                geminiModel: 'gemini-1.5-flash',
                rewritePrompt: 'Eres un editor periodístico profesional. Reescribe la noticia con vocabulario y estructura 100% originales. REGLA CLAVE: FUSIONA los párrafos cortos del original. El artículo final debe tener entre 4 y 6 párrafos de MÍNIMO 3 oraciones cada uno (ideal 4-5 oraciones). NUNCA escribas párrafos de 1 o 2 oraciones solas. Mantén TODOS los datos fácticos: nombres, fechas, cifras y lugares. Tono informativo, neutro y profesional.',
                autoPublish: 1,
                extractImage: 1,
                maxArticlesPerRun: 10,
                articlesPerSource: 2,
                scraperInterval: 0,
                defaultAuthor: 'Redacción DiarioPro'
            };
            const stmt = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
            for (let [k, v] of Object.entries(initialConfig)) {
                stmt.run(k, String(v));
            }
            stmt.finalize();

            const cats = [
                { id: 1, name: 'Nacionales', slug: 'nacionales', color: '#C8102E', active: 1 },
                { id: 2, name: 'Policiales', slug: 'policiales', color: '#E65100', active: 1 },
                { id: 3, name: 'Economía', slug: 'economia', color: '#1565C0', active: 1 },
                { id: 4, name: 'Sociedad', slug: 'sociedad', color: '#2E7D32', active: 1 },
                { id: 5, name: 'Interés', slug: 'interes', color: '#6A1B9A', active: 1 }
            ];
            const stmtC = db.prepare("INSERT INTO categories (id, name, slug, color, active) VALUES (?, ?, ?, ?, ?)");
            cats.forEach(c => stmtC.run(c.id, c.name, c.slug, c.color, c.active));
            stmtC.finalize();

            const sources = [
                { id: 1, name: 'Clarín - Nacionales', url: 'https://www.clarin.com/rss/politica/', categoryId: 1, active: 1 },
                { id: 2, name: 'La Nación - Economía', url: 'https://www.lanacion.com.ar/rss/economia', categoryId: 3, active: 1 },
                { id: 3, name: 'Infobae - Policiales', url: 'https://www.infobae.com/rss/policiales/', categoryId: 2, active: 1 }
            ];
            const stmtS = db.prepare("INSERT INTO sources (id, name, url, categoryId, active) VALUES (?, ?, ?, ?, ?)");
            sources.forEach(s => stmtS.run(s.id, s.name, s.url, s.categoryId, s.active));
            stmtS.finalize();
        }
    });
});

module.exports = db;
