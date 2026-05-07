const axios = require('axios');
const cheerio = require('cheerio');
const Parser = require('rss-parser');
const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent'],
            ['media:thumbnail', 'mediaThumbnail'],
            ['enclosure', 'enclosure'],
            ['image', 'image']
        ]
    }
});

async function extractArticle(url, fallbackTitle) {
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        const $ = cheerio.load(data);
        
        const title = $('h1').first().text().trim() || fallbackTitle;
        const meta = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
        let image = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || $('article img').first().attr('src') || $('main img').first().attr('src') || '';
        
        if (image && !image.startsWith('http')) {
            try {
                const urlObj = new URL(url);
                image = urlObj.origin + (image.startsWith('/') ? '' : '/') + image;
            } catch(e) {}
        }
        // Remove junk more aggressively
        const junkSelectors = [
            'script', 'style', 'nav', 'footer', 'header', 'aside',
            '.sidebar', '.ads', '.advertising', '.promo', '.banner', 
            '.related-posts', '.related-articles', '.suggested-content', '.recommended',
            '.social-share', '.share-buttons', '.sharing',
            '.newsletter', '.subscribe', '.signup',
            '.comments', '#disqus_thread', '.comment-section',
            '.tags', '.categories', '.metadata',
            '.author-bio', '.post-footer', '.author-info',
            '.navigation', '.breadcrumb', '.pagination',
            '.popup', '.modal', '.overlay',
            '[class*="ad-"]', '[id*="ad-"]', '[class*="banner"]', '[id*="banner"]',
            '.widget', '.outbrain', '.taboola', '.revcontent',
            '.noticias-relacionadas', '.notas-relacionadas', '.te-puede-interesar',
            '.mas-leidas', '.ultimas-noticias', '[class*="related"]', '[id*="related"]'
        ];
        junkSelectors.forEach(selector => $(selector).remove());

        let body = '';
        // Try high-probability article containers
        const containers = [
            'article',
            '.article-body',
            '.entry-content',
            '.post-content',
            '.story-body',
            '.article__content',
            '.news-content',
            '#article-content',
            '.tdb_single_content',
            '.td-post-content',
            '.td-post-body',
            'main'
        ];
        
        const stopPhrases = [
            'también te puede interesar',
            'leé también',
            'seguí leyendo',
            'te puede interesar',
            'lee mas',
            'lee más',
            'leer mas',
            'leer más',
            'mirá también',
            'mira también',
            'más noticias',
            'noticias relacionadas',
            'hacé click',
            'registrate',
            'suscribite',
            'copyright',
            'todos los derechos reservados',
            'comentarios',
            'ver comentarios',
            'compartir esta nota',
            'redactora de la sección',
            'redactor de la sección',
            'especializada en noticias',
            'especializado en noticias',
            'recibí en tu mail',
            'historias y análisis de los periodistas',
            '@clarin.com',
            '@lanacion.com'
        ];

        for (let selector of containers) {
            const container = $(selector);
            if (container.length) {
                let tempBody = '';
                container.find('p').each((i, el) => {
                    const $el = $(el);

                    // Skip if it's inside a nested junk container
                    if ($el.closest(junkSelectors.join(',')).length) return;

                    const text = $el.text().trim();
                    if (text.length < 30) return;

                    // Filtrar párrafos que son mayormente un enlace (típico de notas relacionadas)
                    const aText = $el.find('a').text().trim();
                    if (aText.length > text.length * 0.6) return;

                    const lowerText = text.toLowerCase();

                    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) return;

                    for (let phrase of stopPhrases) {
                        if (lowerText.includes(phrase)) {
                            return false;
                        }
                    }

                    tempBody += text + '\n\n';
                });
                
                if (tempBody.trim().length > 300) {
                    body = tempBody;
                    break; 
                }
            }
        }
        
        if (body.length < 300) {
            // Fallback: search all paragraphs but be much stricter
            body = '';
            $('p').each((i, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                
                // Filtrar párrafos que son mayormente un enlace
                const aText = $el.find('a').text().trim();
                if (aText.length > text.length * 0.6) return;
                
                const lowerText = text.toLowerCase();

                // Avoid paragraphs inside common non-content containers
                if ($el.closest('nav, footer, aside, .sidebar, .ads, .related, .recommended, .suggested, .tags, .metadata, .social, .share, [class*="related"], [id*="related"]').length) return;
                
                // Check if we reached a stop phrase
                for (let phrase of stopPhrases) {
                    if (lowerText.includes(phrase)) {
                        return false; // Break loop
                    }
                }

                if (text.length >= 60) {
                    body += text + '\n\n';
                }
            });
        }
        
        if (body.trim().length < 250) return null;
        
        return { title, meta, image, body: body.trim() };
    } catch (error) {
        console.error(`Error extracting ${url}:`, error.message);
        return null;
    }
}

async function fetchRssSource(source, maxItems) {
    try {
        const feed = await parser.parseURL(source.url);
        const items = feed.items.slice(0, maxItems);
        const results = [];
        
        for (let item of items) {
            const article = await extractArticle(item.link, item.title);
            if (article && article.body) {
                let itemImage = '';
                if (item.enclosure && item.enclosure.url) itemImage = item.enclosure.url;
                else if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) itemImage = item.mediaContent.$.url;
                else if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) itemImage = item.mediaThumbnail.$.url;
                else if (item.image) itemImage = item.image;

                results.push({
                    title: article.title,
                    meta: article.meta || item.contentSnippet || '',
                    image: article.image || itemImage || 'https://picsum.photos/seed/' + Date.now() + '/800/500.jpg',
                    body: article.body,
                    source: source.name,
                    slug: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + Date.now(),
                    categoryId: source.categoryId,
                    original_url: item.link
                });
            }
        }
        return results;
    } catch (error) {
        console.error(`Error with RSS ${source.url}, trying HTML fallback:`, error.message);
        try {
            const { data } = await axios.get(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            const $ = cheerio.load(data);
            const links = [];
            let baseUrl = source.url;
            try { baseUrl = new URL(source.url).origin; } catch(e) {}
            
            $('a').each((i, el) => {
                let href = $(el).attr('href');
                if (!href) return;
                
                // Broaden detection: links with many dashes or typical news extensions
                const isNewsLink = (href.match(/-/g) || []).length >= 3 || href.endsWith('.html') || href.endsWith('.htm');
                
                if (href.length > 20 && isNewsLink) {
                    if (!href.startsWith('http')) {
                        href = baseUrl + (href.startsWith('/') ? '' : '/') + href;
                    }
                    // Check if link belongs to the same domain
                    const domain = baseUrl.replace('https://', '').replace('http://', '').split('/')[0];
                    if (!links.includes(href) && href.includes(domain)) {
                        links.push(href);
                    }
                }
            });
            
            const results = [];
            for (let link of links.slice(0, maxItems * 2)) {
                if (results.length >= maxItems) break;
                const article = await extractArticle(link, 'Noticia');
                if (article && article.body && article.body.length > 100) {
                    results.push({
                        title: article.title,
                        meta: article.meta || article.body.substring(0, 150) + '...',
                        image: article.image || 'https://picsum.photos/seed/' + Date.now() + '/800/500.jpg',
                        body: article.body,
                        source: source.name,
                        slug: article.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50) + '-' + Date.now(),
                        categoryId: source.categoryId,
                        original_url: link
                    });
                }
            }
            return results;
        } catch(e) {
            console.error(`HTML fallback failed for ${source.url}:`, e.message);
            return [];
        }
    }
}

module.exports = { fetchRssSource };
