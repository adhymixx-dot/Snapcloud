import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { uploadFile } from "./uploader.js";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const app = express();
app.use(cors());
app.use(express.json());

// Carpeta temporal para uploads
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// Archivos JSON (puedes reemplazar por Supabase luego)
const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// Telegram Client (para descargar archivos)
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
let started = false;
async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram client conectado.");
}

// Leer o crear JSON
function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file));
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

// ---- Registro ----
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

// ---- Login ----
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

// ---- Subida de archivos ----
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });

  try {
    const result = await uploadFile(req.file);

    // Guardar en JSON (puedes reemplazar por Supabase)
    const files = readJSON(FILES_FILE);
    files.push({
      user_id: req.user.id,
      name: result.name,
      fileId: result.fileId,
      thumbId: result.thumbId,
      type: result.type,
      created_at: new Date()
    });
    writeJSON(FILES_FILE, files);

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Error subiendo archivo:", err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// ---- Listar archivos del usuario ----
app.get("/files", authMiddleware, (req, res) => {
  const files = readJSON(FILES_FILE)
    .filter(f => f.user_id === req.user.id)
    .map(f => ({
      name: f.name,
      fileId: f.fileId,
      thumbId: f.thumbId,
      type: f.type
    }));
  res.json(files);
});

// ---- Obtener miniatura desde Telegram ----
app.get("/thumbnail/:thumbId", authMiddleware, async (req, res) => {
  const thumbId = BigInt(req.params.thumbId);
  try {
    await initTelegram();
    const tempPath = path.join(uploadDir, thumbId + "_thumb");
    await client.downloadFile(thumbId, tempPath);
    res.sendFile(tempPath, err => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  } catch (err) {
    console.error("Error obteniendo miniatura:", err);
    res.status(500).json({ error: "No se pudo obtener la miniatura" });
  }
});

// ---- Obtener archivo completo desde Telegram ----
app.get("/file/:fileId", authMiddleware, async (req, res) => {
  const fileId = BigInt(req.params.fileId);
  try {
    await initTelegram();
    const tempPath = path.join(uploadDir, fileId + "_file");
    await client.downloadFile(fileId, tempPath);
    res.sendFile(tempPath, err => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    });
  } catch (err) {
    console.error("Error obteniendo archivo:", err);
    res.status(500).json({ error: "No se pudo obtener el archivo" });
  }
});

// ---- Cerrar sesión (opcional) ----
app.post("/logout", authMiddleware, (req, res) => {
  res.json({ ok: true, message: "Sesión cerrada" });
});

// ---- Servidor ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
