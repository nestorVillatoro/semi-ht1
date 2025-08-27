# api.py
import os
import hashlib
import json
from datetime import datetime
from decimal import Decimal

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

import boto3
from botocore.exceptions import BotoCoreError, ClientError
import mysql.connector
from mysql.connector import pooling

# =========================
# Config / Bootstrap
# =========================
load_dotenv()

APP_ORIGINS = os.getenv("API_CORS_ORIGINS", "http://localhost:3000").split(",")

AWS_REGION = os.getenv("AWS_REGION")
S3_BUCKET = os.getenv("S3_BUCKET_IMGS") or os.getenv("S3_BUCKET")

DB_HOST = os.getenv("DB_HOST")
DB_USER = os.getenv("DB_USER")
DB_PASSWORD = os.getenv("DB_PASSWORD")
DB_NAME = os.getenv("DB_NAME")

if not all([AWS_REGION, S3_BUCKET, DB_HOST, DB_USER, DB_PASSWORD, DB_NAME]):
    print("Revisa variables de entorno: AWS_REGION, S3_BUCKET_IMGS/S3_BUCKET, DB_*")

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": APP_ORIGINS}}, supports_credentials=True, methods=["GET", "POST", "PUT", "DELETE"])

# MySQL pool
cnxpool = pooling.MySQLConnectionPool(
    pool_name="app_pool",
    pool_size=10,
    host=DB_HOST,
    user=DB_USER,
    password=DB_PASSWORD,
    database=DB_NAME,
    autocommit=True,  # manejamos transacciones manualmente cuando hace falta
)

# S3 client (usa credenciales del entorno: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
s3 = boto3.client("s3", region_name=AWS_REGION)


# Utils
def md5hex(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def dictify_row(row, cursor):
    """Convierte tupla -> dict con nombres de columnas (cuando no usamos dictionary=True)"""
    if row is None:
        return None
    cols = [d[0] for d in cursor.description]
    return {cols[i]: row[i] for i in range(len(cols))}


def to_serializable(o):
    if isinstance(o, Decimal):
        return float(o)
    if isinstance(o, (datetime, )):
        return o.isoformat()
    return str(o)


# =========================
# AUTH
# =========================
@app.post("/auth/register")
def register():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        nombre = data.get("nombre_completo")
        password = data.get("password")
        foto_perfil_key = data.get("foto_perfil_key")

        if not username or not nombre or not password:
            return jsonify({"msg": "Faltan campos"}), 400

        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute("SELECT 1 FROM usuarios WHERE username=%s", (username,))
            exists = cur.fetchall()
            if exists:
                return jsonify({"msg": "Usuario ya existe"}), 409

            cur.execute(
                """
                INSERT INTO usuarios (username, nombre_completo, password_md5, foto_perfil_s3, saldo)
                VALUES (%s, %s, %s, %s, 100.00)
                """,
                (username, nombre, md5hex(password), foto_perfil_key or None),
            )
            conn.commit()
            return jsonify({"msg": "Registrado con $100 de saldo inicial"}), 201
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/auth/login")
def login():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        password = data.get("password")
        if not username or not password:
            return jsonify({"msg": "Faltan credenciales"}), 400

        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                """
                SELECT id_usuario, username, nombre_completo, saldo, foto_perfil_s3
                FROM usuarios
                WHERE username=%s AND password_md5=%s
                """,
                (username, md5hex(password)),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"msg": "Credenciales inválidas"}), 401
            # serializar saldo si es Decimal
            row = json.loads(json.dumps(row, default=to_serializable))
            return jsonify(row)
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# GALERÍA
# =========================
@app.get("/gallery")
def gallery():
    try:
        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                """
                SELECT id_obra, titulo, autor_nombre, anio_publicacion, precio, imagen_s3, disponible
                FROM obras
                ORDER BY id_obra DESC
                """
            )
            rows = cur.fetchall()
            rows = json.loads(json.dumps(rows, default=to_serializable))
            return jsonify(rows)
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# PERFIL
# =========================
@app.get("/profile/me")
def profile_me():
    try:
        username = request.args.get("username")
        if not username:
            return jsonify({"msg": "Username requerido"}), 400
        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                "SELECT username, nombre_completo, saldo, foto_perfil_s3 FROM usuarios WHERE username=%s",
                (username,),
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"msg": "Usuario no encontrado"}), 404
            row = json.loads(json.dumps(row, default=to_serializable))
            return jsonify(row)
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.get("/profile/purchased")
def profile_purchased():
    try:
        username = request.args.get("username")
        if not username:
            return jsonify({"msg": "Username requerido"}), 400

        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                """
                SELECT o.id_obra, o.titulo, o.autor_nombre, o.anio_publicacion, o.precio, o.imagen_s3,
                       FALSE as disponible, c.id_compra
                FROM obras o
                JOIN compras c ON o.id_obra = c.id_obra
                JOIN usuarios u ON c.id_usuario = u.id_usuario
                WHERE u.username = %s
                ORDER BY c.id_compra DESC
                """,
                (username,),
            )
            rows = cur.fetchall()
            rows = json.loads(json.dumps(rows, default=to_serializable))
            return jsonify(rows)
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.put("/profile")
def profile_update():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        passwordConfirm = data.get("passwordConfirm")
        usernameNuevo = data.get("usernameNuevo")
        nombre = data.get("nombre_completo")
        foto_perfil_key = data.get("foto_perfil_key")

        if not passwordConfirm:
            return jsonify({"msg": "Contraseña requerida para confirmar"}), 400

        conn = cnxpool.get_connection()
        cur = conn.cursor(dictionary=True)
        try:
            # validar password
            cur.execute(
                "SELECT id_usuario FROM usuarios WHERE username=%s AND password_md5=%s",
                (username, md5hex(passwordConfirm)),
            )
            u = cur.fetchone()
            if not u:
                return jsonify({"msg": "Contraseña incorrecta"}), 401

            # construir UPDATE dinámico (COALESCE behavior)
            sets = []
            params = []
            if usernameNuevo is not None:
                sets.append("username=%s")
                params.append(usernameNuevo)
            if nombre is not None:
                sets.append("nombre_completo=%s")
                params.append(nombre)
            if foto_perfil_key is not None:
                sets.append("foto_perfil_s3=%s")
                params.append(foto_perfil_key)
            if not sets:
                return jsonify({"msg": "Nada que actualizar"})

            params.append(u["id_usuario"])
            sql = f"UPDATE usuarios SET {', '.join(sets)} WHERE id_usuario=%s"
            cur.execute(sql, tuple(params))
            conn.commit()
            return jsonify({"msg": "Perfil actualizado correctamente"})
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/profile/topup")
def profile_topup():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        monto = data.get("monto")
        if not monto or float(monto) <= 0:
            return jsonify({"msg": "Monto inválido"}), 400
        if float(monto) > 1_000_000:
            return jsonify({"msg": "Monto máximo: $1,000,000"}), 400

        conn = cnxpool.get_connection()
        conn.start_transaction()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                "SELECT id_usuario, saldo FROM usuarios WHERE username=%s FOR UPDATE",
                (username,),
            )
            u = cur.fetchone()
            if not u:
                raise Exception("Usuario no existe")

            nuevo = round(float(u["saldo"]) + float(monto), 2)
            cur.execute(
                "UPDATE usuarios SET saldo=%s WHERE id_usuario=%s",
                (nuevo, u["id_usuario"]),
            )
            cur.execute(
                """
                INSERT INTO movimientos_saldo (id_usuario, tipo, monto, id_compra, saldo_resultante)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (u["id_usuario"], "RECARGA", float(monto), None, nuevo),
            )
            conn.commit()
            return jsonify({"saldo": f"{nuevo:.2f}"})
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# COMPRA
# =========================
@app.post("/purchase")
def purchase():
    try:
        data = request.get_json(force=True)
        username = data.get("username")
        id_obra = data.get("id_obra")

        conn = cnxpool.get_connection()
        conn.start_transaction()
        cur = conn.cursor(dictionary=True)
        try:
            cur.execute(
                "SELECT id_usuario, saldo FROM usuarios WHERE username=%s FOR UPDATE",
                (username,),
            )
            u = cur.fetchone()
            if not u:
                raise Exception("Usuario no existe")

            cur.execute(
                "SELECT id_obra, precio, disponible FROM obras WHERE id_obra=%s FOR UPDATE",
                (id_obra,),
            )
            o = cur.fetchone()
            if not o or not o["disponible"]:
                raise Exception("Obra no disponible")

            if float(u["saldo"]) < float(o["precio"]):
                raise Exception("Saldo insuficiente")

            cur.execute(
                "INSERT INTO compras (id_usuario, id_obra, precio_pagado) VALUES (%s, %s, %s)",
                (u["id_usuario"], o["id_obra"], o["precio"]),
            )
            nuevoSaldo = round(float(u["saldo"]) - float(o["precio"]), 2)
            cur.execute(
                "UPDATE usuarios SET saldo=%s WHERE id_usuario=%s",
                (nuevoSaldo, u["id_usuario"]),
            )
            cur.execute("UPDATE obras SET disponible=FALSE WHERE id_obra=%s", (o["id_obra"],))
            cur.execute(
                """
                INSERT INTO movimientos_saldo (id_usuario, tipo, monto, id_compra, saldo_resultante)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (u["id_usuario"], "COMPRA", -float(o["precio"]), None, nuevoSaldo),
            )
            conn.commit()
            return jsonify({"msg": "Compra completada", "saldo": f"{nuevoSaldo:.2f}"})
        except Exception as e:
            conn.rollback()
            return jsonify({"error": str(e)}), 400
        finally:
            cur.close()
            conn.close()
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# =========================
# SUBIR FOTO VÍA BACKEND (sin CORS S3)
# =========================
@app.post("/profile/upload")
def profile_upload():
    try:
        if "file" not in request.files:
            return jsonify({"error": "file requerido"}), 400

        file = request.files["file"]
        userId = request.form.get("userId")
        username = request.form.get("username")

        # Validaciones
        content_type = file.mimetype or "application/octet-stream"
        allowed = {"image/jpeg", "image/png", "image/webp"}
        if content_type not in allowed:
            return jsonify({"error": "Solo JPEG, PNG o WebP"}), 400

        if not S3_BUCKET or not AWS_REGION:
            return jsonify({"error": "Faltan S3_BUCKET_IMGS/AWS_REGION en el servidor"}), 500

        base_raw = (userId or username or "usuario").strip()
        base = "".join([c for c in base_raw.lower() if c.isalnum() or c in "-_"])
        ext = "jpg" if content_type == "image/jpeg" else "png" if content_type == "image/png" else "webp"
        key = f"Fotos_Perfil/{base}.{ext}"

        # Subir a S3
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=file.stream.read(),
            ContentType=content_type,
            # CacheControl="no-cache",  # opcional
        )
        return jsonify({"key": key})
    except (BotoCoreError, ClientError) as e:
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# PRESIGN genérico
# =========================
@app.post("/s3/presign")
def s3_presign_generic():
    try:
        data = request.get_json(force=True)
        folder = data.get("folder")
        filename = data.get("filename")
        content_type = data.get("contentType", "application/octet-stream")
        if not folder or not filename:
            return jsonify({"error": "folder y filename son requeridos"}), 400

        key = f"{folder.strip('/').strip()}/{filename}"
        url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={"Bucket": S3_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=900,
        )
        return jsonify({"uploadUrl": url, "key": key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# PRESIGN perfil (opcional si subes directo desde el navegador)
# =========================
@app.post("/s3/presign-profile")
def s3_presign_profile():
    try:
        data = request.get_json(force=True)
        userId = data.get("userId")
        username = data.get("username")
        content_type = data.get("contentType")
        if not content_type:
            return jsonify({"error": "contentType requerido"}), 400
        if content_type not in {"image/jpeg", "image/png", "image/webp"}:
            return jsonify({"error": "Solo JPEG, PNG o WebP"}), 400
        if not S3_BUCKET or not AWS_REGION:
            return jsonify({"error": "Faltan S3_BUCKET_IMGS/AWS_REGION en el servidor"}), 500

        base_raw = (userId or username or "usuario").strip()
        base = "".join([c for c in base_raw.lower() if c.isalnum() or c in "-_"])
        ext = "jpg" if content_type == "image/jpeg" else "png" if content_type == "image/png" else "webp"
        key = f"Fotos_Perfil/{base}.{ext}"

        url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={"Bucket": S3_BUCKET, "Key": key, "ContentType": content_type},
            ExpiresIn=900,
        )
        return jsonify({"uploadUrl": url, "key": key})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# HEALTH CHECK
# =========================
@app.get("/check")
def check():
    return jsonify(
        {
            "mensaje": "La API de Python está funcionando correctamente",
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
    )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
