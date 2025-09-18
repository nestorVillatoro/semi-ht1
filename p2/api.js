// api.js
require("dotenv").config();

const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const axios = require("axios");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs"); // NUEVO: hash/compare de contraseñas

const app = express();

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("dev"));

// ---------- ENV ----------
const {
  PORT = 5000,
  DB_HOST,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  APIM_BASE,
  APIM_KEY
} = process.env;

// ---------- Pool MySQL ----------
let pool;
async function initPool() {
  pool = mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4"
  });
}
initPool().catch((e) => {
  console.error("Error creando pool MySQL:", e?.message || e);
});

// ---------- Helpers ----------
function apim() {
  if (!APIM_BASE) {
    throw new Error("APIM_BASE no configurado en .env");
  }
  const headers = { "Content-Type": "application/json" };
  if (APIM_KEY && APIM_KEY.trim() !== "") {
    headers["Ocp-Apim-Subscription-Key"] = APIM_KEY.trim();
  }
  return axios.create({
    baseURL: APIM_BASE,
    timeout: 10000,
    headers
  });
}

function mapAxiosError(err, fallbackMessage) {
  if (err.response) {
    return {
      status: err.response.status,
      body:
        typeof err.response.data === "object"
          ? err.response.data
          : { ok: false, error: String(err.response.data) },
    };
  }
  if (err.request) {
    return {
      status: 504,
      body: { ok: false, error: "Tiempo de espera agotado llamando a la función." },
    };
  }
  return { status: 500, body: { ok: false, error: fallbackMessage || "Error interno." } };
}

function sanitizeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    foto_perfil_url: row.foto_perfil_url || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ====================== Rutas Básicas =========================
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "recipeboxcloud-api-local", time: new Date().toISOString() });
});

// Verifica conexión a la BD (no hace negocio)
app.get("/db/ping", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query("SELECT 1 AS ok");
      res.json({ ok: true, db: rows[0].ok === 1 });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error conectando a MySQL" });
  }
});

// ====================== Auth =========================
// Registro: username/email únicos + hash de contraseña
app.post("/auth/register", async (req, res) => {
  const { username, email, password, foto_perfil_url = null } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ ok: false, error: "username, email y password son obligatorios." });
  }
  try {
    const conn = await pool.getConnection();
    try {
      const [dup] = await conn.execute(
        "SELECT id FROM usuarios WHERE username = ? OR email = ? LIMIT 1",
        [username, email]
      );
      if (dup.length) {
        return res.status(409).json({ ok: false, error: "username o email ya están en uso." });
      }
      const hash = await bcrypt.hash(password, 10);
      const [result] = await conn.execute(
        `INSERT INTO usuarios (username, email, password_hash, foto_perfil_url)
         VALUES (?, ?, ?, ?)`,
        [username, email, hash, foto_perfil_url]
      );
      const [rows] = await conn.execute("SELECT * FROM usuarios WHERE id = ? LIMIT 1", [result.insertId]);
      return res.status(201).json({ ok: true, user: sanitizeUser(rows[0]) });
    } finally {
      conn.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error en registro." });
  }
});

// Login: valida credenciales contra hash
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "username y password son obligatorios." });
  }
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute("SELECT * FROM usuarios WHERE username = ? LIMIT 1", [username]);
      if (rows.length === 0) return res.status(401).json({ ok: false, error: "Credenciales inválidas." });
      const u = rows[0];
      const ok = await bcrypt.compare(password, u.password_hash);
      if (!ok) return res.status(401).json({ ok: false, error: "Credenciales inválidas." });
      return res.json({ ok: true, user: sanitizeUser(u) });
    } finally {
      conn.release();
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "Error en login." });
  }
});

// ====================== Recetas (listados locales para frontend) =========================
// Explorar (lista general)
app.get("/recetas", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(`
        SELECT r.id, r.autor_id, u.username AS autor_username,
               r.titulo, r.descripcion_corta, r.imagen_url,
               r.created_at, r.updated_at
        FROM recetas r
        JOIN usuarios u ON u.id = r.autor_id
        ORDER BY r.created_at DESC
        LIMIT 100
      `);
      res.json({ ok: true, data: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error listando recetas." });
  }
});

// Mis Recetas (por autor)
app.get("/mis-recetas", async (req, res) => {
  const autor_id = Number(req.query.autor_id || 0);
  if (!autor_id) return res.status(400).json({ ok: false, error: "autor_id requerido" });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(`
        SELECT r.id, r.autor_id, u.username AS autor_username,
               r.titulo, r.descripcion_corta, r.imagen_url,
               r.created_at, r.updated_at
        FROM recetas r
        JOIN usuarios u ON u.id = r.autor_id
        WHERE r.autor_id = ?
        ORDER BY r.created_at DESC
      `, [autor_id]);
      res.json({ ok: true, data: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error listando mis recetas." });
  }
});

// Favoritos - listar
app.get("/favoritos", async (req, res) => {
  const usuario_id = Number(req.query.usuario_id || 0);
  if (!usuario_id) return res.status(400).json({ ok: false, error: "usuario_id requerido" });
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(`
        SELECT r.id, r.autor_id, u.username AS autor_username,
               r.titulo, r.descripcion_corta, r.imagen_url,
               r.created_at, r.updated_at
        FROM favoritos f
        JOIN recetas r ON r.id = f.receta_id
        JOIN usuarios u ON u.id = r.autor_id
        WHERE f.usuario_id = ?
        ORDER BY f.created_at DESC
      `, [usuario_id]);
      res.json({ ok: true, data: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error listando favoritos." });
  }
});

// Favoritos - agregar (idempotente)
app.post("/favoritos/:id", async (req, res) => {
  const receta_id = Number(req.params.id || 0);
  const usuario_id = Number(req.body?.usuario_id || 0);
  if (!receta_id || !usuario_id) {
    return res.status(400).json({ ok: false, error: "usuario_id y receta_id requeridos" });
  }
  try {
    const conn = await pool.getConnection();
    try {
      await conn.execute(
        "INSERT IGNORE INTO favoritos (usuario_id, receta_id) VALUES (?, ?)",
        [usuario_id, receta_id]
      );
      res.status(201).json({ ok: true });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Error guardando favorito." });
  }
});

// ====================== Proxy a Funciones APIM =========================
// 1) Subir foto al contenedor (uploadProfilePhoto)
app.post("/upload-foto", async (req, res) => {
  try {
    const client = apim();
    const url = "/func-recipebox-g1/uploadProfilePhoto";
    const { data, status } = await client.post(url, req.body);
    res.status(status).json(data);
  } catch (err) {
    const { status, body } = mapAxiosError(err, "Error subiendo foto.");
    res.status(status).json(body);
  }
});

// 2) Crear/guardar receta (setReceta)
app.post("/recetas", async (req, res) => {
  try {
    const client = apim();
    const url = "/func-recipebox-g1-getReceta/setReceta";
    const { data, status } = await client.post(url, req.body);
    res.status(status).json(data);
  } catch (err) {
    const { status, body } = mapAxiosError(err, "Error guardando la receta.");
    res.status(status).json(body);
  }
});

// 3) Obtener una receta por id (getReceta/{id})
app.get("/recetas/:id", async (req, res) => {
  try {
    const client = apim();
    const { id } = req.params;
    const { usuario_id } = req.query;

    const basePath = `/func-recipebox-g1-obtenerReceta/getReceta/${encodeURIComponent(id)}`;
    const qs = usuario_id ? `?usuario_id=${encodeURIComponent(usuario_id)}` : "";
    const url = basePath + qs;

    const { data, status } = await client.get(url);
    res.status(status).json(data);
  } catch (err) {
    const { status, body } = mapAxiosError(err, "Error obteniendo la receta.");
    res.status(status).json(body);
  }
});

// ====================== Arranque =========================
app.listen(PORT, () => {
  console.log(`API local escuchando en http://localhost:${PORT}`);
});
