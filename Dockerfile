FROM node:20-alpine

# Instalar dependencias de sistema para sqlite3 (compilación nativa)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copiar solo el package.json primero (cache de capas de Docker)
COPY package*.json ./
RUN npm install --production

# Copiar el código fuente
COPY . .

# Directorio de datos persistente (montar como volumen en Coolify)
RUN mkdir -p /data

# Exponer el puerto de la aplicación
EXPOSE 3001

# Healthcheck para que Coolify/Docker sepa si la app está viva
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3001/api/state || exit 1

# Iniciar la aplicación
CMD ["node", "server.js"]
