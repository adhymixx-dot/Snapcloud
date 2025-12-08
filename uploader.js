import express from "express";
import multer from "multer";
import cors from "cors";
import { uploadToTelegram } from "./uploader.js";
import fs from "fs/promises"; // Usar la versión de promesas para operaciones asíncronas
import path from "path";

// --- SUPABASE IMPORTS ---
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

// --- SUPABASE SETUP ---
// Las variables de entorno deben ser definidas en tu entorno de alojamiento (Render, etc.)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

let supabaseClient;
let isDbReady = false;

try {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    isDbReady = true;
    console.log("Supabase conectado.");
  } else {
    console.error("Faltan variables de entorno de Supabase (SUPABASE_URL o SUPABASE_ANON_KEY).");
  }
} catch (e) {
  console.error("Error al inicializar Supabase:", e);
}


// Crear carpeta temporal si no existe
const uploadDir = path.join(process.cwd(), "uploads");
// Usar fs.promises.mkdir para operación asíncrona
fs.mkdir(uploadDir, { recursive: true }).catch(err => {
    if (err.code !== 'EEXIST') console.error("Error creando directorio 'uploads':", err);
});

// Multer usando diskStorage
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send(`SnapCloud Backend funcionando! Supabase Ready: ${isDbReady}`);
});

// Subir archivo y registrar en Supabase
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!isDbReady) {
      return res.status(503).json({ error: "El servidor no está conectado a la base de datos Supabase." });
  }

  try {
    if (!req.file) return res.status(400).json({ error: "No se proporcionó ningún archivo" });

    // 1. Subir el archivo a Telegram 
    const result = await uploadToTelegram(req.file);
    const fileId = result.id || result;

    // 2. Guardar el registro en la tabla 'telegram_uploads' de Supabase
    const { data, error } = await supabaseClient
      .from('telegram_uploads')
      .insert([
        { 
          telegram_file_id: fileId.toString(),
          name: req.file.originalname,
          mime_type: req.file.mimetype,
          size: req.file.size,
          // user_id: 'anonymous' // O podrías usar un ID de usuario de Supabase si implementas Auth
        }
      ])
      .select(); // Devolver el registro insertado

    if (error) {
      console.error("Error al guardar en Supabase:", error);
      throw new Error(`Fallo al registrar en Supabase: ${error.message}`);
    }

    res.json({
      ok: true,
      fileId: fileId.toString(),
      dbId: data[0].id, // El ID generado por la tabla de Supabase
      message: "Archivo subido correctamente al canal privado y registrado"
    });

  } catch (err) {
    console.error("Error en /upload:", err);
    res.status(500).json({ error: err.message || "Error interno del servidor" });
  }
});

// Obtener lista de archivos subidos (desde Supabase)
app.get("/files", async (req, res) => {
  if (!isDbReady) {
      return res.status(503).json({ error: "El servidor no está conectado a la base de datos Supabase." });
  }
  
  try {
    // 1. Obtener todos los registros de la tabla 'telegram_uploads'
    // Se recomienda usar el campo 'created_at' para ordenar, el cual PostgreSQL genera por defecto.
    const { data, error } = await supabaseClient
      .from('telegram_uploads')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error("Error al obtener datos de Supabase:", error);
      throw new Error(`Fallo al obtener archivos de Supabase: ${error.message}`);
    }

    // 2. Mapear los datos al formato esperado por el frontend
    const files = data.map(f => ({
      id: f.telegram_file_id, 
      name: f.name,
      dbId: f.id, 
      uploaderId: f.user_id || 'anonymous',
      uploadedAt: new Date(f.created_at).toLocaleString() 
    }));

    res.json(files);

  } catch (err) {
    console.error("Error en /files:", err);
    res.status(500).json({ error: "Error al obtener la lista de archivos" });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});