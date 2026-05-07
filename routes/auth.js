require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { loginLimiter } = require('../config/middleware');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
// Eliminar constantes globales de admin para permitir cambio en caliente

// Validar que JWT_SECRET esté configurado
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('CRITICO: JWT_SECRET no configurado o muy corto. Configuralo en .env');
    process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error('CRITICO: ADMIN_USERNAME y ADMIN_PASSWORD deben estar configurados en .env');
    process.exit(1);
}

router.post('/login',
    loginLimiter,
    [
        body('username').trim().notEmpty().isLength({ max: 50 }),
        body('password').notEmpty().isLength({ max: 100 })
    ],
    (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ success: false, error: 'Datos de acceso invalidos' });
        }

        const { username, password } = req.body;
        const currentAdminUser = process.env.ADMIN_USERNAME;
        const currentAdminPass = process.env.ADMIN_PASSWORD;

        if (username !== currentAdminUser || password !== currentAdminPass) {
            // Respuesta genérica para no revelar cuál campo es incorrecto
            return res.status(401).json({ success: false, error: 'Credenciales inválidas' });
        }

        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token });
    }
);

module.exports = router;
