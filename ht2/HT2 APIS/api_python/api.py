# api.py
from flask import Flask, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)

_allowed = os.getenv("ALLOWED_ORIGINS", "*")
origins = [o.strip() for o in _allowed.split(",")] if _allowed != "*" else "*"

CORS(
    app,
    resources={r"/*": {
        "origins": origins,
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        # Activa si vas a usar cookies/Authorization de navegador entre dominios:
        "supports_credentials": False
    }},
    # Responde automáticamente preflights OPTIONS
)

@app.get("/check")
def check():
    return jsonify({"message": "La API de Python está funcionando correctamente"}), 200

@app.get("/get-data")
def info():
    return jsonify({
        "Instancia": "Maquina 2 - Api 2",
        "Curso": "Seminario de Sistemas 1 A",
        "Grupo": "Grupo 1",
        "Lenguaje": "Python"
    }), 200

if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.getenv("PORT", "5000"))
    print(f"Servidor corriendo en http://{host}:{port} | ALLOWED_ORIGINS={origins}")
    app.run(host=host, port=port, debug=True, use_reloader=False)
