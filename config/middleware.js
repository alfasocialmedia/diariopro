require('dotenv').config();
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(o => o.trim());

const corsOptions = {
    origin: (origin, callback) => {
        // Permitir requests sin origin (curl, Postman, apps móviles)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Origen no permitido por CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
};

// CSP: se usa 'unsafe-inline' para mantener compatibilidad con los onclick/onchange
// inline del frontend. Aun asi, bloquea scripts de dominios no autorizados, conecta
// solo al propio servidor, y previene framing, plugins y manipulacion de base-uri.
const helmetOptions = {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com"
            ],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com"
            ],
            imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com"],
            connectSrc: [
                "'self'",
                "https://api.openai.com",
                "https://generativelanguage.googleapis.com",
                "https://openrouter.ai",
                "https://dolarapi.com",
                "https://api.argentinadatos.com",
                "blob:",
                "wss:",
                "ws:"
            ],
            mediaSrc: ["'self'", "https:", "http:", "blob:"],
            frameSrc: [
                "'self'",
                "https://www.youtube.com",
                "https://youtube.com",
                "https://youtu.be",
                "https://player.vimeo.com",
                "https:",
                "http:"
            ],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
};

// Rate limiter general para la API
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' }
});

// Rate limiter estricto solo para login (previene fuerza bruta)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' }
});

module.exports = { corsOptions, helmetOptions, apiLimiter, loginLimiter };
