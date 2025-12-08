import express from "express";
import multer from "multer";
import cors from "cors";
import fetch from "node-fetch"; // ⚠️ Necesario instalar: npm install node-fetch
import { uploadToTelegram } from "./uploader.js";

const app = express();
app.use(cors()); // permite que el frontend en Netlify haga requests
app.use(express.json());

// Multer para archivos grandes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Endpoint raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// ===== Registro de usuario =====
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Datos incompletos" });

    // Llamada a Apps Script para guardar usuario
    const response = await fetch("TU_APPS_SCRIPT_URL", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "register", username, password })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error en /register:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Login de usuario =====
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Datos incompletos" });

    // Llamada a Apps Script para validar usuario
    const response = await fetch("TU_APPS_SCRIPT_URL", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "login", username, password })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error en /login:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Subida de archivos =====
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.body.username) return res.status(400).json({ error: "Faltan datos" });

    const telegramResult = await uploadToTelegram(req.file);
    const telegramFileId = telegramResult.id || telegramResult;

    // Guardar metadata en Google Sheets vía Apps Script
    await fetch("TU_APPS_SCRIPT_URL", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upload",
        username: req.body.username,
        fileName: req.file.originalname,
        telegramFileId
      })
    });

    res.json({ ok: true, fileId: telegramFileId, message: "Archivo subido correctamente" });
  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Listar archivos del usuario =====
app.get("/files", async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "Falta username" });

    const response = await fetch("TU_APPS_SCRIPT_URL?action=list&username=" + encodeURIComponent(username));
    const files = await response.json();
    res.json(files);
  } catch (err) {
    console.error("Error en /files:", err);
    res.status(500).json({ error: err.message });
  }
});

// Puerto asignado por Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
