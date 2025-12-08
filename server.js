import express from "express";
import multer from "multer";
import cors from "cors";
import { uploadToTelegram } from "./uploader.js";

const app = express();
app.use(cors());
app.use(express.json());

// Multer para archivos grandes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Endpoint raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Subida de archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const telegramResult = await uploadToTelegram(req.file);
    const telegramFileId = telegramResult.id || telegramResult;

    // Guardar metadata en Google Sheets vía Apps Script
    const response = await fetch("https://script.google.com/macros/s/AKfycbxZED-LfBaRR1q3mpwX2WzALowmzVANnBDqq1wDfhJNoB0fTMo8j_B1ftPlf6eBbwdZ/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: req.body.userId,
        fileName: req.file.originalname,
        telegramFileId
      })
    });
    await response.json();

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
    const response = await fetch(`TU_APPS_SCRIPT_URL?username=${userId}`);
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
