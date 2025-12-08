import express from "express";
import multer from "multer";
import cors from "cors";
import { uploadToTelegram } from "./uploader.js";

const app = express();

// 🔹 Habilitar CORS globalmente para todos los endpoints
app.use(cors()); // permite cualquier origen temporalmente
app.use(express.json());

// Multer en memoria para archivos grandes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Para guardar info de archivos subidos (solo localmente)
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

    // Guardar info básica
    uploadedFiles.push({
      id: result.id || result,
      name: req.file.originalname
    });

    res.json({
      ok: true,
      fileId: result.id || result,
      message: "Archivo subido correctamente"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// Listar archivos subidos
app.get("/files", (req, res) => {
  res.json(uploadedFiles);
});

// Puerto Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
