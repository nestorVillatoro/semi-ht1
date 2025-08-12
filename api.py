from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)



@app.route('/check', methods=['GET'])
def check():
    return jsonify({"message": "La API de Python esta funcionando correctamente"}), 200

@app.route('/info', methods=['GET'])
def info():
    return jsonify({
        "Instancia": "Maquina 2 - Api 2",
        "Curso": "Seminario de Sistemas 1 A",
        "Grupo": "Grupo 1"
    }), 200

if __name__ == "__main__":
    saludo = "http://localhost:5000"
    print(f"Servidor corriendo en {saludo}")
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
