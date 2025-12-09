import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

const app = express();
app.use(cors());
app.use(express.json());

// ---- Carpeta temporal ----
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// ---- Archivos JSON ----
const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");

// ---- JWT Secret ----
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// ---- Telegram ----
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const botChannelId = BigInt(process.env.TELEGRAM_BOT_CHANNEL);
const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL);
const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;
async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado.");
}

// ---- Funciones JSON ----
function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file));
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Middleware de autenticación ----
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
  users.push({ id: Date.now(), email, password: hash });
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

// ---- Generar miniatura ----
function generateThumbnail(filePath, type) {
  return new Promise((resolve, reject) => {
    const thumbPath = filePath + "_thumb.jpg";
    if (type === "image") {
      sharp(filePath)
        .resize(200, 200, { fit: "cover" })
        .toFile(thumbPath)
        .then(() => resolve(thumbPath))
        .catch(reject);
    } else if (type === "video") {
      ffmpeg(filePath)
        .screenshots({
          count: 1,
          folder: path.dirname(filePath),
          filename: path.basename(thumbPath),
          size: "200x200"
        })
        .on("end", () => resolve(thumbPath))
        .on("error", reject);
    } else reject(new Error("Tipo desconocido para miniatura"));
  });
}

// ---- Subir archivo ----
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    await initTelegram();
    const type = req.file.mimetype.startsWith("video") ? "video" : "image";

    // Generar miniatura
    const thumbPath = await generateThumbnail(req.file.path, type);

    // Subir archivo original al canal del usuario
    const resultOriginal = await client.sendFile(userChannelId, { file: req.file.path, caption: "Archivo SnapCloud" });

    // Subir miniatura al canal del bot
    const resultThumb = await client.sendFile(botChannelId, { file: thumbPath, caption: "Miniatura" });

    fs.unlinkSync(req.file.path);
    fs.unlinkSync(thumbPath);

    // Guardar metadata
    const files = readJSON(FILES_FILE);
    files.push({
      user_id: req.user.id,
      name: req.file.originalname,
      fileId: resultOriginal.id,
      thumbId: resultThumb.id,
      type,
      created_at: new Date()
    });
    writeJSON(FILES_FILE, files);

    res.json({ ok: true, fileId: resultOriginal.id, thumbId: resultThumb.id });
  } catch (err) {
    console.error("Error en /upload:", err);
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message || "Error subiendo archivo" });
  }
});

// ---- Listar archivos del usuario ----
app.get("/files", authMiddleware, (req, res) => {
  const files = readJSON(FILES_FILE).filter(f => f.user_id === req.user.id);
  res.json(files);
});

// ---- Servir miniaturas ----
app.get("/thumbnail/:thumbId", authMiddleware, async (req, res) => {
  const thumbId = BigInt(req.params.thumbId);
  try {
    await initTelegram();
    const tempPath = path.join(uploadDir, `${thumbId}_thumb`);
    await client.downloadFile(thumbId, tempPath);
    res.type("image/jpeg");
    res.sendFile(tempPath, () => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); });
  } catch (err) {
    console.error("Error miniatura:", err);
    res.status(500).json({ error: "No se pudo obtener la miniatura" });
  }
});

// ---- Servir archivo completo ----
app.get("/file/:fileId", authMiddleware, async (req, res) => {
  const fileId = BigInt(req.params.fileId);
  try {
    await initTelegram();
    const tempPath = path.join(uploadDir, `${fileId}_file`);
    await client.downloadFile(fileId, tempPath);
    res.sendFile(tempPath, () => { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); });
  } catch (err) {
    console.error("Error archivo:", err);
    res.status(500).json({ error: "No se pudo obtener el archivo" });
  }
});

// ---- Cerrar sesión opcional (frontend) ----

// ---- Servidor ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
