import express from "express";
import multer from "multer";
import cors from "cors";
import { uploadToTelegram } from "./uploader.js";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

// Crear carpeta temporal si no existe
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Multer usando diskStorage
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

const uploadedFiles = [];

// Ruta raíz
app.get("/", (req, res) => {
  res.send("SnapCloud Backend funcionando!");
});

// Subir archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const result = await uploadToTelegram(req.file);

    uploadedFiles.push({
      id: result.id || result,
      name: req.file.originalname
    });

    res.json({
      ok: true,
      fileId: result.id || result,
      message: "Archivo subido correctamente al canal privado"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message || "Error subiendo archivo" });
  }
});

// Listar archivos subidos
app.get("/files", (req, res) => {
  res.json(uploadedFiles);
});

// Puerto asignado por Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
