import 'dotenv/config'; // Cargar variables de entorno
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

// Validar que las variables de entorno existan
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error("ERROR: Debes configurar SUPABASE_URL y SUPABASE_SERVICE_KEY en las variables de entorno");
  process.exit(1);
}

if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH || !process.env.TELEGRAM_CHANNEL_ID || !process.env.TELEGRAM_SESSION) {
  console.error("ERROR: Debes configurar las variables de Telegram en el .env o Render");
  process.exit(1);
}

// Conectar a Supabase (backend)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Carpeta temporal para archivos
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Middleware para validar token Supabase
async function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "No autorizado" });

  const { data: user, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "No autorizado" });

  req.user = user.user; // Objeto del usuario
  next();
}

// Ruta raíz
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Subida de archivo (solo usuarios logueados)
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    // Subir a Telegram
    const result = await uploadToTelegram(req.file);

    // Guardar metadata en Supabase
    const { error: insertError } = await supabase
      .from("files")
      .insert([{
        user_id: req.user.id,
        name: req.file.originalname,
        telegram_id: result.id || result
      }]);

    if (insertError) {
      console.error("Error guardando en Supabase:", insertError);
    }

    res.json({
      ok: true,
      fileId: result.id || result,
      message: "Archivo subido correctamente"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message || "Error subiendo archivo" });

    // Borrar archivo temporal si falla
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// Listar archivos del usuario
app.get("/files", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("files")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    res.json(data);

  } catch (err) {
    console.error("Error en /files:", err);
    res.status(500).json({ error: err.message });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
