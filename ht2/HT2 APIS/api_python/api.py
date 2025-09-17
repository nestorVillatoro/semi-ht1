from flask import Flask, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)
# CORS abierto para todos los orígenes y métodos
CORS(app)

@app.get("/check")
def check():
    return jsonify({"message": "La API de Python está funcionando correctamente"}), 200

@app.get("/get-data")
def get_data():
    return jsonify({
        "Instancia": "Maquina 2 - Api 2",
        "Curso": "Seminario de Sistemas 1 A",
        "Grupo": "Grupo 1",
        "Lenguaje": "Python"
    }), 200

if __name__ == "__main__":
    host = "0.0.0.0"
    port = int(os.getenv("PORT", "5000"))
    print(f"Servidor Flask en http://{host}:{port}")
    app.run(host=host, port=port, debug=False, use_reloader=False)
