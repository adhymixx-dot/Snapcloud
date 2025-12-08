import 'dotenv/config';
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import { uploadToTelegram } from "./uploader.js";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ---------------------
// CORS
// ---------------------
app.use(cors({
  origin: "https://snapcloud.netlify.app", // tu frontend
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json());

// ---------------------
// Supabase
// ---------------------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("ERROR: Debes configurar SUPABASE_URL y SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// ---------------------
// Carpetas
// ---------------------
const uploadDir = path.join(process.cwd(), "uploads");
const thumbDir = path.join(process.cwd(), "thumbnails");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// ---------------------
// Middleware auth Supabase
// ---------------------
async function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "No autorizado" });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "No autorizado" });

  req.user = data.user;
  next();
}

// ---------------------
// Rutas
// ---------------------
app.get("/", (req, res) => res.send("SnapCloud Backend funcionando!"));

// Subir archivo
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });

  try {
    // Subir a Telegram
    const result = await uploadToTelegram(req.file);

    // Crear miniatura (solo imagen)
    const ext = path.extname(req.file.filename).toLowerCase();
    let thumbPath = null;
    if (/\.(jpg|jpeg|png|gif)$/i.test(ext)) {
      const sharp = await import("sharp");
      thumbPath = path.join(thumbDir, req.file.filename + ".jpg");
      await sharp.default(req.file.path).resize(200).toFile(thumbPath);
    }

    // Guardar metadata en Supabase
    const { error: insertError } = await supabase
      .from("files")
      .insert([{
        user_id: req.user.id,
        filename: req.file.filename,
        telegram_id: result.id || result,
        thumb: thumbPath ? `/thumbnails/${req.file.filename}.jpg` : null
      }]);

    if (insertError) console.error("Error guardando en Supabase:", insertError);

    res.json({
      ok: true,
      fileId: result.id || result,
      filename: req.file.filename,
      thumb: thumbPath ? `/thumbnails/${req.file.filename}.jpg` : null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// Listar archivos del usuario
app.get("/files", authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from("files")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Servir miniaturas
app.use("/thumbnails", express.static(thumbDir));

// ---------------------
// Servidor
// ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
