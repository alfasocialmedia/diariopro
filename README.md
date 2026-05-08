# DiarioPro

Portal de noticias automatizado con scraping de RSS, reescritura con IA y panel administrativo.

## Tecnologías

- **Backend**: Node.js + Express 5
- **Base de datos**: SQLite 3
- **Autenticación**: JWT (JSON Web Tokens)
- **Seguridad**: Helmet, express-rate-limit, express-validator
- **Scraping**: axios + cheerio + rss-parser
- **IA**: OpenAI / Google Gemini / OpenRouter (configurable)
- **Frontend**: HTML/CSS/JS vanilla

## Instalación

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus valores reales (ver sección Configuración)

# 3. Iniciar el servidor
node server.js
```

El servidor estará disponible en `http://localhost:3000`

## Configuración (.env)

| Variable | Descripción | Ejemplo |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `NODE_ENV` | Entorno de ejecución | `development` |
| `JWT_SECRET` | Secreto para firmar tokens JWT (mínimo 32 caracteres) | *(cadena aleatoria larga)* |
| `ADMIN_USERNAME` | Usuario del administrador | `admin` |
| `ADMIN_PASSWORD` | Contraseña del administrador | *(contraseña segura)* |
| `ALLOWED_ORIGINS` | Orígenes CORS permitidos (separados por coma) | `http://localhost:3000` |

Para generar un `JWT_SECRET` seguro:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## API

### Autenticación

```
POST /api/login
Body: { "username": "admin", "password": "..." }
Respuesta: { "success": true, "token": "eyJ..." }
```

El token debe enviarse en el header `Authorization: Bearer <token>` en todas las rutas protegidas.

### Artículos (público)

```
GET /api/articles?page=1&limit=20&q=búsqueda&category=1&status=published
```

Parámetros opcionales:
- `page` - Número de página (default: 1)
- `limit` - Artículos por página (default: 20, máx: 100)
- `q` - Búsqueda en título o descripción
- `category` - Filtrar por ID de categoría
- `status` - Filtrar por estado (`published` o `draft`)

### Estado completo (público)

```
GET /api/state
```

### Sincronización (requiere token)

```
POST /api/sync
Body: { "key": "config|categories|sources|schedules|articles", "data": [...] }
```

### Scraping (requiere token)

```
POST /api/scrape              # Todas las fuentes activas
POST /api/scrape/:id          # Fuente específica por ID
```

### Reescritura con IA (requiere token)

```
POST /api/rewrite
Body: { "article": { "id": 1, "title": "...", "body": "..." } }
```

### Logs del scraper (requiere token)

```
GET /api/logs
```

## Estructura del proyecto

```
diariopro/
├── server.js           # Punto de entrada del servidor
├── .env                # Variables de entorno (NO subir a git)
├── .env.example        # Ejemplo de configuración
├── .gitignore
├── package.json
├── config/
│   ├── middleware.js   # Helmet, CORS, rate limiting
│   └── db-helpers.js   # Funciones auxiliares de base de datos
├── routes/
│   ├── auth.js         # Ruta de login
│   ├── api.js          # Rutas de API (state, sync, rewrite, artículos)
│   └── scraper.js      # Rutas del scraper y proceso de scraping
├── services/
│   ├── scraper.js      # Lógica de extracción RSS/HTML
│   └── ai-rewriter.js  # Integración con APIs de IA
├── database/
│   ├── db.js           # Inicialización de SQLite y tablas
│   └── diariopro.db    # Base de datos (NO subir a git)
├── public/
│   ├── index.html      # Portal de noticias
│   └── admin.html      # Panel administrativo
└── scratch/            # Scripts de desarrollo (no son parte del sistema)
```

## Seguridad implementada

- **Helmet**: Headers HTTP de seguridad (CSP, XSS, HSTS, etc.)
- **Rate limiting**: Máx. 10 intentos de login por IP cada 15 minutos; 200 peticiones API por IP cada 15 minutos
- **CORS restrictivo**: Solo orígenes definidos en `ALLOWED_ORIGINS`
- **JWT**: Tokens firmados con secreto desde variable de entorno, expiración 24h
- **Validación de entrada**: Todos los endpoints validan y sanitizan sus inputs
- **Sanitización SQL**: Uso de prepared statements en todas las queries
- **Variables de entorno**: Sin credenciales hardcodeadas en el código

## Configuración de IA

Desde el panel admin → IA Config se puede seleccionar el proveedor y configurar la API Key:

- **OpenAI**: Usar `gpt-4o-mini` (recomendado por costo/calidad)
- **Google Gemini**: Usar `gemini-1.5-flash`
- **OpenRouter**: Acceso a múltiples modelos con una sola API key

## Cronjobs automáticos

El sistema ejecuta el scraper automáticamente según:
1. **Horarios globales**: Configurables desde Admin → Programación (ej: 06:00, 12:00, 20:00)
2. **Por fuente**: Cada fuente RSS puede tener su propio horario o frecuencia en horas
