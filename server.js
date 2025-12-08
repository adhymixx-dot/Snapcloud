import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { uploadToTelegram } from "./uploader.js";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Carpeta temporal
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

const uploadedFiles = [];

// Middleware para validar token Supabase
async function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "No autorizado" });

  const { data: user, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "No autorizado" });

  req.user = user;
  next();
}

// Ruta raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Subir archivo (solo usuarios logueados)
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const result = await uploadToTelegram(req.file);

    uploadedFiles.push({
      id: result.id || result,
      name: req.file.originalname,
      user: req.user.user.id
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
app.get("/files", authMiddleware, (req, res) => {
  const userFiles = uploadedFiles.filter(f => f.user === req.user.user.id);
  res.json(userFiles);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
