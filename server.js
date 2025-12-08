// server.js
import express from "express";
import multer from "multer";
import cors from "cors";
import fetch from "node-fetch";
import { uploadToTelegram } from "./uploader.js";

const app = express();
app.use(cors());
app.use(express.json());

// Multer para archivos grandes en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// URL de tu Apps Script
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxZED-LfBaRR1q3mpwX2WzALowmzVANnBDqq1wDfhJNoB0fTMo8j_B1ftPlf6eBbwdZ/exec";

// Ruta raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Registrar usuario
app.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Faltan datos" });

    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "register", username, password })
    });

    res.json({ ok: true, message: "Usuario registrado correctamente" });
  } catch (err) {
    console.error("Error en /register:", err);
    res.status(500).json({ error: err.message });
  }
});

// Login usuario
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Faltan datos" });

    const response = await fetch(`${APPS_SCRIPT_URL}?action=login&username=${username}&password=${password}`);
    const data = await response.json();

    if (data.ok) res.json({ ok: true, message: "Login exitoso" });
    else res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  } catch (err) {
    console.error("Error en /login:", err);
    res.status(500).json({ error: err.message });
  }
});

// Subir archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const telegramResult = await uploadToTelegram(req.file);
    const telegramFileId = telegramResult.id || telegramResult;

    // Guardar metadata en Google Sheets
    await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upload",
        username: req.body.userId,
        fileName: req.file.originalname,
        telegramFileId
      })
    });

    res.json({
      ok: true,
      fileId: telegramFileId,
      message: "Archivo subido y guardado correctamente"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message });
  }
});

// Listar archivos de un usuario
app.get("/files", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "Falta userId" });

    const response = await fetch(`${APPS_SCRIPT_URL}?action=list&username=${userId}`);
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
