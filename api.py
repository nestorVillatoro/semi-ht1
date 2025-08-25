# app.py
import os, hashlib
from flask import Flask, request, jsonify
import mysql.connector
from mysql.connector import pooling
import boto3
from botocore.signers import CloudFrontSigner  # opcional

from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)

dbpool = pooling.MySQLConnectionPool(
    pool_name="rds_pool", pool_size=5,
    host=os.getenv("DB_HOST"), user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"), database=os.getenv("DB_NAME")
)

def md5hex(s: str) -> str:
    return hashlib.md5(s.encode('utf-8')).hexdigest()

@app.post("/auth/register")
def register():
    data = request.get_json()
    username = data.get("username"); nombre = data.get("nombre_completo")
    password = data.get("password"); foto_key = data.get("foto_perfil_key")
    if not username or not nombre or not password:
        return jsonify({"msg":"Faltan campos"}), 400
    cn = dbpool.get_connection(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("SELECT 1 FROM usuarios WHERE username=%s", (username,))
        if cur.fetchone(): return jsonify({"msg":"Usuario ya existe"}), 409
        cur.execute("""INSERT INTO usuarios (username,nombre_completo,password_md5,foto_perfil_s3)
                       VALUES (%s,%s,MD5(%s),%s)""", (username, nombre, password, foto_key))
        cn.commit(); return jsonify({"msg":"Registrado"}), 201
    finally:
        cur.close(); cn.close()

@app.post("/auth/login")
def login():
    data = request.get_json(); username = data.get("username"); password = data.get("password")
    cn = dbpool.get_connection(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("""SELECT id_usuario,username,nombre_completo,saldo,foto_perfil_s3
                       FROM usuarios WHERE username=%s AND password_md5=MD5(%s)""",
                    (username, password))
        row = cur.fetchone()
        if not row: return jsonify({"msg":"Credenciales inválidas"}), 401
        return jsonify(row)
    finally:
        cur.close(); cn.close()

@app.get("/gallery")
def gallery():
    cn = dbpool.get_connection(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("""SELECT id_obra,titulo,autor_nombre,anio_publicacion,precio,imagen_s3,disponible
                       FROM obras ORDER BY id_obra DESC""")
        return jsonify(cur.fetchall())
    finally:
        cur.close(); cn.close()

@app.get("/profile/me")
def me():
    username = request.args.get("username")
    cn = dbpool.get_connection(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("""SELECT username,nombre_completo,saldo,foto_perfil_s3 FROM usuarios WHERE username=%s""",(username,))
        row = cur.fetchone()
        if not row: return jsonify({"msg":"No encontrado"}), 404
        return jsonify(row)
    finally:
        cur.close(); cn.close()

@app.put("/profile")
def profile_update():
    data = request.get_json()
    username = data.get("username"); pwd = data.get("passwordConfirm")
    newu = data.get("usernameNuevo"); nombre = data.get("nombre_completo"); foto_key = data.get("foto_perfil_key")
    cn = dbpool.get_connection(); cur = cn.cursor()
    try:
        cur.execute("SELECT id_usuario FROM usuarios WHERE username=%s AND password_md5=MD5(%s)", (username, pwd))
        row = cur.fetchone()
        if not row: return jsonify({"msg":"Confirmación inválida"}), 401
        idu = row[0]
        cur.execute("""UPDATE usuarios SET username=COALESCE(%s,username),
                       nombre_completo=COALESCE(%s,nombre_completo),
                       foto_perfil_s3=COALESCE(%s,foto_perfil_s3) WHERE id_usuario=%s""",
                    (newu, nombre, foto_key, idu))
        cn.commit(); return jsonify({"msg":"Actualizado"})
    finally:
        cur.close(); cn.close()

@app.post("/profile/topup")
def topup():
    data = request.get_json(); username = data.get("username"); monto = data.get("monto")
    if not monto or float(monto) <= 0: return jsonify({"msg":"Monto inválido"}), 400
    cn = dbpool.get_connection(); cn.start_transaction(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("SELECT id_usuario,saldo FROM usuarios WHERE username=%s FOR UPDATE",(username,))
        u = cur.fetchone(); 
        if not u: raise Exception("Usuario no existe")
        nuevo = round(float(u["saldo"]) + float(monto), 2)
        cur.execute("UPDATE usuarios SET saldo=%s WHERE id_usuario=%s",(nuevo, u["id_usuario"]))
        cur.execute("""INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante)
                       VALUES (%s,'RECARGA',%s,NULL,%s)""",(u["id_usuario"], monto, nuevo))
        cn.commit(); return jsonify({"saldo": f"{nuevo:.2f}"})
    except Exception as e:
        cn.rollback(); return jsonify({"error": str(e)}), 500
    finally:
        cur.close(); cn.close()

@app.post("/purchase")
def purchase():
    data = request.get_json(); username = data.get("username"); id_obra = data.get("id_obra")
    cn = dbpool.get_connection(); cn.start_transaction(); cur = cn.cursor(dictionary=True)
    try:
        cur.execute("SELECT id_usuario,saldo FROM usuarios WHERE username=%s FOR UPDATE",(username,))
        u = cur.fetchone(); 
        if not u: raise Exception("Usuario no existe")
        cur.execute("SELECT id_obra,precio,disponible FROM obras WHERE id_obra=%s FOR UPDATE",(id_obra,))
        o = cur.fetchone()
        if not o or not o["disponible"]: raise Exception("Obra no disponible")
        if float(u["saldo"]) < float(o["precio"]): raise Exception("Saldo insuficiente")
        cur.execute("INSERT INTO compras (id_usuario,id_obra,precio_pagado) VALUES (%s,%s,%s)",
                    (u["id_usuario"], o["id_obra"], o["precio"]))
        nuevo = round(float(u["saldo"]) - float(o["precio"]), 2)
        cur.execute("UPDATE usuarios SET saldo=%s WHERE id_usuario=%s",(nuevo, u["id_usuario"]))
        cur.execute("UPDATE obras SET disponible=FALSE WHERE id_obra=%s",(o["id_obra"],))
        cur.execute("""INSERT INTO movimientos_saldo (id_usuario,tipo,monto,id_compra,saldo_resultante)
                       VALUES (%s,'COMPRA',%s,NULL,%s)""",(u["id_usuario"], -float(o["precio"]), nuevo))
        cn.commit(); return jsonify({"msg":"Compra completada", "saldo": f"{nuevo:.2f}"})
    except Exception as e:
        cn.rollback(); return jsonify({"error": str(e)}), 400
    finally:
        cur.close(); cn.close()

# S3 presign usando boto3
@app.post("/s3/presign")
def s3_presign():
    data = request.get_json(); folder = data.get("folder"); filename = data.get("filename"); content_type = data.get("contentType", "application/octet-stream")
    key = f"{folder}/{filename}"
    s3 = boto3.client("s3", region_name=os.getenv("AWS_REGION"))
    url = s3.generate_presigned_url(
        ClientMethod='put_object',
        Params={'Bucket': os.getenv("S3_BUCKET_IMGS"), 'Key': key, 'ContentType': content_type},
        ExpiresIn=900, HttpMethod='PUT'
    )
    return jsonify({"uploadUrl": url, "key": key})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")))
