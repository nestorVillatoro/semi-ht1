const express = require("express");
const app = express();

app.get("/", (req, res) => res.json({ msg: "API de prueba Express OK" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on 0.0.0.0:${PORT}`);
});
