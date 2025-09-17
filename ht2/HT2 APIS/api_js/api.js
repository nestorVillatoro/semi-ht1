// api.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Política CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);               // Postman/cURL
    if (allowed.includes('*') || allowed.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origen no permitido: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: process.env.CORS_CREDENTIALS === 'true' // si usarás cookies/autenticación
};

app.use(cors(corsOptions));
app.use(express.json());

// Opcional: responder explícitamente preflight (cors ya lo maneja, pero esto ayuda con proxies)
app.options('*', cors(corsOptions));

// Rutas
app.get('/check', (req, res) => {
  res.status(200).json({ mensaje: 'La API de JavaScript está funcionando correctamente' });
});

app.get('/get-data', (req, res) => {
  res.status(200).json({
    Instancia: 'Maquina 1 - Api 1',
    Curso: 'Seminario de Sistemas 1 A',
    Grupo: 'Grupo 1',
    Lenguaje: 'JavaScript'
  });
});

// Arranque
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log(`ALLOWED_ORIGINS=${allowed.join(', ') || '*'}`);
  console.log(`CORS_CREDENTIALS=${process.env.CORS_CREDENTIALS === 'true'}`);
});
