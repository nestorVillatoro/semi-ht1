// api.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const cors = require("cors");
const multer = require("multer");

// AWS SDK v3
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// ---------- APP ----------
const app = express();

// ---------- MIDDLEWARE ----------
app.use(express.json());

// CORS de tu API (frontend -> API). Agrega tu dominio en prod.
const origins = process.env.API_CORS_ORIGINS
  ? process.env.API_CORS_ORIGINS.split(",")
  : ["http://localhost:3000"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || origins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS bloqueado para " + origin), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.options("*", cors());


// Multer: archivo en memoria (5MB máx.)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ---------- DB (RDS) ----------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- AWS S3 ----------
const REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET_IMGS || process.env.S3_BUCKET;
if (!REGION || !BUCKET) {
  console.warn(
    "Falta AWS_REGION o S3_BUCKET_IMGS/S3_BUCKET en variables de entorno"
  );
}
const s3 = new S3Client({ region: REGION });

// Utilidad MD5 (si la usas en otro lado)
const md5hex = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

// =========================================================
//                    AUTENTICACIÓN
// =========================================================
app.post("/auth/register", async (req, res) => {
  try {
    const { username, nombre_completo, password, foto_perfil_key } = req.body;
    if (!username || !nombre_completo || !password)
      return res.status(400).json({ msg: "Faltan campos" });
    const [exists] = await db.query(
      "SELECT 1 FROM usuarios WHERE username=?",
      [username]
    );
    if (exists.length) return res.status(409).json({ msg: "Usuario ya existe" });
    await db.query(
      "INSERT INTO usuarios (username,nombre_completo,password_md5,foto_perfil_s3,saldo) VALUES (?,?,MD5(?),?,100.00)",
      [username, nombre_completo, password, foto_perfil_key || null]
    );
    res.status(201).json({ msg: "Registrado con $100 de saldo inicial" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.query(
      "SELECT id_usuario,username,nombre_completo,saldo,foto_perfil_s3 FROM usuarios WHERE username=? AND password_md5=MD5(?)",
      [username, password]
    );
    if (!rows.length) return res.status(401).json({ msg: "Credenciales inválidas" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
//                       GALERÍA
// =========================================================
app.get("/gallery", async (_req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id_obra,titulo,autor_nombre,anio_publicacion,precio,imagen_s3,disponible FROM obras ORDER BY id_obra DESC"
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
app.get("/profile/me", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ msg: "Username requerido" });
    const [rows] = await db.query(
      "SELECT username,nombre_completo,saldo,foto_perfil_s3 FROM usuarios WHERE username=?",
      [username]
    );
    if (!rows.length) return res.status(404).json({ msg: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obras adquiridas
app.get("/profile/purchased", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ msg: "Username requerido" });

    const [rows] = await db.query(
      `
      SELECT o.id_obra, o.titulo, o.autor_nombre, o.anio_publicacion, o.precio, o.imagen_s3,
             FALSE as disponible, c.id_compra
      FROM obras o
      JOIN compras c ON o.id_obra = c.id_obra
      JOIN usuarios u ON c.id_usuario = u.id_usuario
      WHERE u.username = ?
      ORDER BY c.id_compra DESC
    `,
      [username]
    );

    res.json(rows);
  } catch (e) {
    console.error("Error getting purchased artworks:", e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/profile", async (req, res) => {
  try {
    const {
      username,
      passwordConfirm,
      usernameNuevo,
      nombre_completo,
      foto_perfil_key,
    } = req.body;
    if (!passwordConfirm)
      return res
        .status(400)
        .json({ msg: "Contraseña requerida para confirmar" });

    const [u] = await db.query(
      "SELECT id_usuario FROM usuarios WHERE username=? AND password_md5=MD5(?)",
      [username, passwordConfirm]
    );
    if (!u.length) return res.status(401).json({ msg: "Contraseña incorrecta" });

    await db.query(
      "UPDATE usuarios SET username=COALESCE(?,username), nombre_completo=COALESCE(?,nombre_completo), foto_perfil_s3=COALESCE(?,foto_perfil_s3) WHERE id_usuario=?",
      [usernameNuevo, nombre_completo, foto_perfil_key, u[0].id_usuario]
    );
    res.json({ msg: "Perfil actualizado correctamente" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/profile/topup", async (req, res) => {
  try {
    const { username, monto } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ msg: "Monto inválido" });
    if (monto > 1000000) return res.status(400).json({ msg: "Monto máximo: $1,000,000" });

    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [u] = await conn.query(
        "SELECT id_usuario,saldo FROM usuarios WHERE username=? FOR UPDATE",
        [username]
      );
      if (!u.length) throw new Error("Usuario no existe");
      const nuevo = (Number(u[0].saldo) + Number(monto)).toFixed(2);
      await conn.query("UPDATE usuarios SET saldo=? WHERE id_usuario=?", [
        nuevo,
        u[0].id_usuario,
      ]);
      await conn.query(
        "INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante) VALUES (?,?,?,?,?)",
        [u[0].id_usuario, "RECARGA", monto, null, nuevo]
      );
      await conn.commit();
      conn.release();
      res.json({ saldo: nuevo });
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
//                      COMPRA
// =========================================================
app.post("/purchase", async (req, res) => {
  try {
    const { username, id_obra } = req.body;
    const conn = await db.getConnection();
    await conn.beginTransaction();

    try {
      const [u] = await conn.query(
        "SELECT id_usuario,saldo FROM usuarios WHERE username=? FOR UPDATE",
        [username]
      );
      if (!u.length) throw new Error("Usuario no existe");

      const [o] = await conn.query(
        "SELECT id_obra,precio,disponible FROM obras WHERE id_obra=? FOR UPDATE",
        [id_obra]
      );
      if (!o.length || !o[0].disponible) throw new Error("Obra no disponible");

      if (Number(u[0].saldo) < Number(o[0].precio))
        throw new Error("Saldo insuficiente");

      await conn.query(
        "INSERT INTO compras (id_usuario,id_obra,precio_pagado) VALUES (?,?,?)",
        [u[0].id_usuario, o[0].id_obra, o[0].precio]
      );

      const nuevoSaldo = (Number(u[0].saldo) - Number(o[0].precio)).toFixed(2);
      await conn.query("UPDATE usuarios SET saldo=? WHERE id_usuario=?", [
        nuevoSaldo,
        u[0].id_usuario,
      ]);
      await conn.query("UPDATE obras SET disponible=FALSE WHERE id_obra=?", [
        o[0].id_obra,
      ]);

      await conn.query(
        "INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante) VALUES (?,?,?,?,?)",
        [u[0].id_usuario, "COMPRA", -Number(o[0].precio), null, nuevoSaldo]
      );

      await conn.commit();
      conn.release();
      res.json({ msg: "Compra completada", saldo: nuevoSaldo });
    } catch (e) {
      await conn.rollback();
      conn.release();
      throw e;
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =========================================================
//        SUBIR FOTO VÍA BACKEND (sin CORS en S3)
// =========================================================
app.post("/profile/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file requerido" });

    const { userId, username } = req.body || {};
    const contentType = req.file.mimetype;

    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) {
      return res.status(400).json({ error: "Solo JPEG, PNG o WebP" });
    }
    if (!BUCKET || !REGION)
      return res
        .status(500)
        .json({ error: "Faltan S3_BUCKET_IMGS/AWS_REGION en el servidor" });

    const baseRaw = (userId ?? username ?? "usuario").toString();
    const base = baseRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const ext =
      contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
        ? "webp"
        : "jpg";
    const key = `Fotos_Perfil/${base}.${ext}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: contentType,
        // CacheControl: "no-cache", // opcional
      })
    );

    res.json({ key });
  } catch (e) {
    console.error("upload perfil error:", e);
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
//    PRESIGN GENÉRICO (consistente con getSignedUrl)
// =========================================================
app.post("/s3/presign", async (req, res) => {
  try {
    const { folder, filename, contentType } = req.body || {};
    if (!folder || !filename)
      return res.status(400).json({ error: "folder y filename son requeridos" });

    const key = `${String(folder).replace(/^\/+|\/+$/g, "")}/${filename}`;
    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType || "application/octet-stream",
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // STRING
    res.json({ uploadUrl: url, key });
  } catch (e) {
    console.error("presign error:", e);
    res.status(500).json({ error: e.message });
  }
});

// =========================================================
//    PRESIGN PERFIL (opcional, si vuelves a subir directo)
// =========================================================
app.post("/s3/presign-profile", async (req, res) => {
  try {
    const { userId, username, contentType } = req.body || {};
    if (!contentType)
      return res.status(400).json({ error: "contentType requerido" });

    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowed.has(contentType)) {
      return res.status(400).json({ error: "Solo JPEG, PNG o WebP" });
    }
    if (!BUCKET || !REGION) {
      return res
        .status(500)
        .json({ error: "Faltan S3_BUCKET_IMGS/AWS_REGION en el servidor" });
    }

    const baseRaw = (userId ?? username ?? "usuario").toString();
    const base = baseRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const ext =
      contentType === "image/png"
        ? "png"
        : contentType === "image/webp"
        ? "webp"
        : "jpg";
    const key = `Fotos_Perfil/${base}.${ext}`;

    const cmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // STRING
    res.json({ uploadUrl: url, key });
  } catch (e) {
    console.error("presign-profile error:", e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// =========================================================
//                      HEALTH CHECK
// =========================================================
app.get("/check", (_req, res) => {
  res.status(200).json({
    mensaje: "La API de JavaScript está funcionando correctamente",
    timestamp: new Date().toISOString(),
  });
});

// ---------- START ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Node API en :${PORT}`));
