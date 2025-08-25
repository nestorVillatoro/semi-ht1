// index.js
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const app = express();
app.use(express.json());

// Pool MySQL (RDS)
const db = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  waitForConnections: true, connectionLimit: 10
});

// Utilidad MD5
const md5hex = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');

// ---------- AUTH ----------
app.post('/auth/register', async (req, res) => {
  try {
    const { username, nombre_completo, password, foto_perfil_key } = req.body;
    if (!username || !nombre_completo || !password) return res.status(400).json({msg:'Faltan campos'});
    const [exists] = await db.query('SELECT 1 FROM usuarios WHERE username=?', [username]);
    if (exists.length) return res.status(409).json({msg:'Usuario ya existe'});
    await db.query(
      'INSERT INTO usuarios (username,nombre_completo,password_md5,foto_perfil_s3) VALUES (?,?,MD5(?),?)',
      [username, nombre_completo, password, foto_perfil_key || null]
    );
    res.status(201).json({msg:'Registrado'});
  } catch (e) { res.status(500).json({error:e.message}); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.query(
      'SELECT id_usuario,username,nombre_completo,saldo,foto_perfil_s3 FROM usuarios WHERE username=? AND password_md5=MD5(?)',
      [username, password]
    );
    if (!rows.length) return res.status(401).json({msg:'Credenciales inválidas'});
    res.json(rows[0]);
  } catch (e) { res.status(500).json({error:e.message}); }
});

// ---------- GALERÍA ----------
app.get('/gallery', async (_req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id_obra,titulo,autor_nombre,anio_publicacion,precio,imagen_s3,disponible FROM obras ORDER BY id_obra DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({error:e.message}); }
});

// ---------- PERFIL ----------
app.get('/profile/me', async (req, res) => {
  // Para demo: enviar ?username=xxx; en producción usa sesión/JWT
  const { username } = req.query;
  const [rows] = await db.query('SELECT username,nombre_completo,saldo,foto_perfil_s3 FROM usuarios WHERE username=?',[username]);
  if (!rows.length) return res.status(404).json({msg:'No encontrado'});
  res.json(rows[0]);
});

app.put('/profile', async (req, res) => {
  const { username, passwordConfirm, usernameNuevo, nombre_completo, foto_perfil_key } = req.body;
  const [u] = await db.query('SELECT id_usuario FROM usuarios WHERE username=? AND password_md5=MD5(?)',[username, passwordConfirm]);
  if (!u.length) return res.status(401).json({msg:'Confirmación inválida'});
  await db.query('UPDATE usuarios SET username=COALESCE(?,username), nombre_completo=COALESCE(?,nombre_completo), foto_perfil_s3=COALESCE(?,foto_perfil_s3) WHERE id_usuario=?',
    [usernameNuevo, nombre_completo, foto_perfil_key, u[0].id_usuario]);
  res.json({msg:'Actualizado'});
});

app.post('/profile/topup', async (req, res) => {
  const { username, monto } = req.body;
  if (!monto || monto<=0) return res.status(400).json({msg:'Monto inválido'});
  const conn = await db.getConnection(); await conn.beginTransaction();
  try {
    const [u] = await conn.query('SELECT id_usuario,saldo FROM usuarios WHERE username=? FOR UPDATE',[username]);
    if (!u.length) throw new Error('Usuario no existe');
    const nuevo = (Number(u[0].saldo) + Number(monto)).toFixed(2);
    await conn.query('UPDATE usuarios SET saldo=? WHERE id_usuario=?',[nuevo, u[0].id_usuario]);
    await conn.query('INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante) VALUES (?,?,?,?,?)',
      [u[0].id_usuario,'RECARGA',monto,null,nuevo]);
    await conn.commit(); conn.release();
    res.json({saldo:nuevo});
  } catch (e) { await conn.rollback(); conn.release(); res.status(500).json({error:e.message}); }
});

// ---------- COMPRA ----------
app.post('/purchase', async (req, res) => {
  const { username, id_obra } = req.body;
  const conn = await db.getConnection(); await conn.beginTransaction();
  try {
    const [u] = await conn.query('SELECT id_usuario,saldo FROM usuarios WHERE username=? FOR UPDATE',[username]);
    if (!u.length) throw new Error('Usuario no existe');
    const [o] = await conn.query('SELECT id_obra,precio,disponible FROM obras WHERE id_obra=? FOR UPDATE',[id_obra]);
    if (!o.length || !o[0].disponible) throw new Error('Obra no disponible');
    if (Number(u[0].saldo) < Number(o[0].precio)) throw new Error('Saldo insuficiente');

    await conn.query('INSERT INTO compras (id_usuario,id_obra,precio_pagado) VALUES (?,?,?)',
      [u[0].id_usuario, o[0].id_obra, o[0].precio]);

    const nuevoSaldo = (Number(u[0].saldo) - Number(o[0].precio)).toFixed(2);
    await conn.query('UPDATE usuarios SET saldo=? WHERE id_usuario=?',[nuevoSaldo, u[0].id_usuario]);
    await conn.query('UPDATE obras SET disponible=FALSE WHERE id_obra=?',[o[0].id_obra]);

    // movimiento negativo
    await conn.query('INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante) VALUES (?,?,?,?,?)',
      [u[0].id_usuario,'COMPRA', -Number(o[0].precio), null, nuevoSaldo]);

    await conn.commit(); conn.release();
    res.json({msg:'Compra completada', saldo:nuevoSaldo});
  } catch (e) { await conn.rollback(); conn.release(); res.status(400).json({error:e.message}); }
});

// ---------- S3: presign (opcional si subes desde frontend con PUT) ----------
const { S3RequestPresigner } = require('@aws-sdk/s3-request-presigner');
const { Hash } = require('@aws-sdk/hash-node');
const { HttpRequest } = require('@aws-sdk/protocol-http');

app.post('/s3/presign', async (req, res) => {
  const { folder, filename, contentType } = req.body;
  const key = `${folder}/${filename}`;
  const s3 = new S3Client({ region: process.env.AWS_REGION });
  const presigner = new S3RequestPresigner({ ...s3.config, sha256: Hash.bind(null, 'sha256') });
  const url = await presigner.presign(new HttpRequest({
    protocol: 'https:',
    method: 'PUT',
    hostname: `${process.env.S3_BUCKET_IMGS}.s3.${process.env.AWS_REGION}.amazonaws.com`,
    path: `/${key}`,
    headers: { 'content-type': contentType || 'application/octet-stream' }
  }), { expiresIn: 900 });
  res.json({ uploadUrl: url, key });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Node API en :${PORT}`));
