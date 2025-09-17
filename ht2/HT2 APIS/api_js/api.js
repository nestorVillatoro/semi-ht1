const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// CORS abierto para todos los orígenes y métodos
app.use(cors());
app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Servidor Express en http://localhost:${PORT}`);
});
