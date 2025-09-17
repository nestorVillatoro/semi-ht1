const express = require('express')
const cors = require('cors')
const app = express()
const port = 5000


app.use(cors())
app.use(express.json())


app.get('/check', (req, res) => {
    res.status(200).json({
        mensaje: "La API de JavaScript esta funcionando correctamente"
    })    
})

app.get('/get-data', (req, res) => {
    res.status(200).json({
        "Instancia": "Maquina 1 - Api 1",
        "Curso": "Seminario de Sistemas 1 A",
        "Grupo": "Grupo 1",
        "Lenguaje": "JavaScript"
    })
})

app.listen(port,  () =>{
    console.log("Servidor corriendo en http://localhost:" + port)
})