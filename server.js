import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { uploadToTelegram, downloadFromTelegram } from "./uploader.js";

const app = express();
app.use(cors());
app.use(express.json());

// Multer en disco temporal
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, "temp/"),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Asegurarse de que exista carpeta temporal
if (!fs.existsSync("temp")) fs.mkdirSync("temp");

// URL de Apps Script
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyVVUlspr7pbtujmpjHUKH_8Ru18o2h_8jl2iuK0z_AOaC6BIC1SkGCLUbrAMEgPMH3/exec"; // reemplaza con la tuya

// Ruta raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Subir archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  const userId = req.body.userId || "anon";

  if (!req.file) return res.status(400).json({ error: "No file provided" });

  try {
    // Subir a Telegram
    const result = await uploadToTelegram(req.file);

    // Guardar en Google Sheets
    await fetch(SHEETS_URL, {
      method: "POST",
      body: JSON.stringify({
        userId,
        fileName: req.file.originalname,
        telegramFileId: result.id || result
      }),
      headers: { "Content-Type": "application/json" }
    });

    // Borrar archivo temporal
    fs.unlinkSync(req.file.path);

    res.json({ ok: true, fileId: result.id || result, message: "Archivo subido correctamente" });
  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message || "Error subiendo archivo" });
  }
});

// Endpoint para listar archivos de un usuario
app.get("/files", async (req, res) => {
  const userId = req.query.userId || "anon";
  try {
    const response = await fetch(`${SHEETS_URL}?userId=${userId}`);
    const files = await response.json();
    res.json(files);
  } catch (err) {
    console.error("Error en /files:", err);
    res.status(500).json({ error: "Error obteniendo archivos" });
  }
});

// Descargar archivo desde Telegram
app.get("/download", async (req, res) => {
  const { fileId, fileName } = req.query;
  if (!fileId) return res.status(400).send("Falta fileId");

  try {
    const buffer = await downloadFromTelegram(fileId); // implementar en uploader.js
    res.setHeader("Content-Disposition", `attachment; filename="${fileName || "file"}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Error en /download:", err);
    res.status(500).send("Error descargando archivo");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
