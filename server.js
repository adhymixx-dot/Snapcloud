import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
// Importar funciones de uploader.js
import { uploadToTelegram, uploadThumbnail, getFileUrl } from "./uploader.js"; 
// Importar funciones de thumbnailer.js
import { generateThumbnail, cleanupThumbnail } from "./thumbnailer.js"; 

const app = express();
app.use(cors({ origin: "https://snapcloud.netlify.app" })); 
app.use(express.json());

// Carpeta para uploads temporales
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configuración multer
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Archivos JSON
const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// Leer/guardar JSON
function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`Error leyendo ${file}:`, e);
    return [];
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Middleware de autenticación
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "No autorizado" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// Registro
app.post("/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email y password son requeridos" });
  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email === email)) return res.status(400).json({ error: "Usuario ya existe" });
  const hash = await bcrypt.hash(password, 10);
  const newUser = { id: Date.now(), email, password: hash };
  users.push(newUser);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true, message: "Usuario registrado" });
});

// Login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: "Usuario no encontrado" });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ error: "Password incorrecto" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ ok: true, token });
});


// 🚀 RUTA CRUCIAL DE SUBIDA (CORREGIDA) 🚀
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  let thumbPath = null;
  
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    // PASO 1: Generar la miniatura
    thumbPath = await generateThumbnail(req.file);

    // PASO 2: Subir la miniatura y obtener su ID (largo y correcto).
    const thumbnailResult = await uploadThumbnail(thumbPath); 
    // ✅ CLAVE: Usamos .telegram_id que devuelve el ID único para la API HTTP del Bot
    const thumbnailId = thumbnailResult.telegram_id; 
    
    if (!thumbnailId) throw new Error("No se pudo obtener el ID del archivo de la miniatura.");

    // 🚀 PASO 3: Subir el archivo original al canal del usuario
    const originalResult = await uploadToTelegram(req.file);
    // ✅ CLAVE: Usamos .telegram_id que devuelve el ID único para la API HTTP del Bot
    const originalId = originalResult.telegram_id; 

    if (!originalId) throw new Error("No se pudo obtener el ID del archivo original.");

    // PASO 4: Guardar metadata y limpiar
    const files = readJSON(FILES_FILE);
    files.push({
      id: Date.now(),
      user_id: req.user.id,
      name: req.file.originalname,
      mime: req.file.mimetype,
      thumbnail_id: thumbnailId,   // ID de archivo (string largo y correcto)
      telegram_id: originalId,     // ID de archivo (string largo y correcto)
      created_at: new Date()
    });
    writeJSON(FILES_FILE, files);
    
    // Limpiar archivos locales
    fs.unlinkSync(req.file.path);
    cleanupThumbnail(thumbPath);

    res.json({ ok: true, fileId: originalId, thumbnailId: thumbnailId, message: "Archivo subido correctamente" });
  } catch (err) {
    console.error("Error en /upload:", err);
    // Asegurar limpieza en caso de error
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (thumbPath && fs.existsSync(thumbPath)) cleanupThumbnail(thumbPath);
    res.status(500).json({ error: err.message || "Error subiendo archivo" });
  }
});

// Listar archivos del usuario
app.get("/files", authMiddleware, (req, res) => {
  const files = readJSON(FILES_FILE).filter(f => f.user_id === req.user.id);
  res.json(files);
});

// Ruta CRUCIAL: Obtener URL de la CDN de Telegram
app.get("/file-url/:file_id", authMiddleware, async (req, res) => {
    try {
        const fileId = req.params.file_id;
        const url = await getFileUrl(fileId); 
        res.json({ url });
    } catch (error) {
        console.error("Error en /file-url:", error.message);
        res.status(500).json({ error: error.message || "Error al obtener la URL del archivo de Telegram" });
    }
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));