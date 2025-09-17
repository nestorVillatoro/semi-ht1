// api.js
'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// CORS abierto para todos
app.use(cors());
app.use(express.json());

// Rutas
app.get('/check', (_req, res) => {
  res.status(200).json({ mensaje: 'La API de JavaScript está funcionando correctamente' });
});

app.get('/get-data', (_req, res) => {
  res.status(200).json({
    Instancia: 'Maquina 1 - Api 1',
    Curso: 'Seminario de Sistemas 1 A',
    Grupo: 'Grupo 1',
    Lenguaje: 'JavaScript'
  });
});

// 404 (sin comodines)
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Manejo de errores
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => {
  console.log(`Servidor Express en http://localhost:${PORT}`);
});
