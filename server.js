// server.js
import express from "express";
import multer from "multer";
import cors from "cors";
import { uploadToTelegram } from "./uploader.js"; // tu archivo de subida a Telegram

const app = express();
app.use(cors()); // permitir todas las solicitudes (temporalmente)
app.use(express.json());

// Multer en memoria para archivos grandes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// ✅ Ruta raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// 🔹 Subir archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const telegramResult = await uploadToTelegram(req.file);
    const telegramFileId = telegramResult.id || telegramResult;

    // Guardar metadata en Google Sheets vía Apps Script
    const scriptUrl = "https://script.google.com/macros/s/AKfycbxZED-LfBaRR1q3mpwX2WzALowmzVANnBDqq1wDfhJNoB0fTMo8j_B1ftPlf6eBbwdZ/exec";

    const response = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: req.body.userId,
        fileName: req.file.originalname,
        telegramFileId
      })
    });

    await response.json(); // opcional: puedes manejar la respuesta de Apps Script

    res.json({
      ok: true,
      fileId: telegramFileId,
      message: "Archivo subido y metadata guardada correctamente"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Listar archivos de un usuario
app.get("/files", async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: "No se proporcionó userId" });

    // Llamada a tu Apps Script que devuelve los archivos de este usuario
    const scriptUrl = `https://script.google.com/macros/s/AKfycbxZED-LfBaRR1q3mpwX2WzALowmzVANnBDqq1wDfhJNoB0fTMo8j_B1ftPlf6eBbwdZ/exec?username=${encodeURIComponent(userId)}`;
    const response = await fetch(scriptUrl);
    const files = await response.json();

    res.json(files);

  } catch (err) {
    console.error("Error en /files:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Puerto asignado por Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
