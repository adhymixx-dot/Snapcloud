import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy"; 
import { uploadFromStream, uploadThumbnailBuffer, getFileUrl, streamFile } from "./uploader.js"; 

const app = express();
const allowedOrigins = ["https://snapcloud.netlify.app", "http://localhost:5173", "http://localhost:3000"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('No permitido por CORS'));
  }
}));
app.use(express.json());

const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");
const JWT_SECRET = process.env.JWT_SECRET || "secreto";

function readJSON(file) { if (!fs.existsSync(file)) return []; return JSON.parse(fs.readFileSync(file)); }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if (!token) return res.status(401).json({ error: "No auth" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ error: "Token bad" }); }
}

app.post("/register", async (req, res) => {
    // ... (Tu código de registro existente)
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Datos faltantes" });
    const users = readJSON(USERS_FILE);
    if (users.find(u => u.email === email)) return res.status(400).json({ error: "Existe" });
    const hash = await bcrypt.hash(password, 10);
    users.push({ id: Date.now(), email, password: hash });
    writeJSON(USERS_FILE, users);
    res.json({ ok: true });
});

app.post("/login", async (req, res) => {
    // ... (Tu código de login existente)
    const { email, password } = req.body;
    const users = readJSON(USERS_FILE);
    const user = users.find(u => u.email === email);
    if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Credenciales mal" });
    res.json({ ok: true, token: jwt.sign({ id: user.id, email: user.email }, JWT_SECRET) });
});

// 🚀 RUTA DE SUBIDA INTELIGENTE (Video Stream + Miniatura Buffer) 🚀
app.post("/upload", authMiddleware, (req, res) => {
  const bb = busboy({ headers: req.headers });
  
  // Promesas para esperar a que terminen las subidas
  let videoUploadPromise = null;
  let thumbUploadPromise = Promise.resolve(null); // Por defecto es null si no envían miniatura

  // Variables temporales para guardar datos del archivo
  let fileName = "";
  let mimeType = "";

  bb.on('file', (name, file, info) => {
    const { filename, mimeType: mime } = info;

    if (name === "thumbnail") {
        // 🖼️ Si el campo se llama 'thumbnail', leemos todo en un buffer (es pequeño)
        console.log("📸 Recibiendo miniatura...");
        const chunks = [];
        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', () => {
            const buffer = Buffer.concat(chunks);
            // Iniciamos subida de miniatura
            thumbUploadPromise = uploadThumbnailBuffer(buffer)
                .catch(err => {
                    console.error("Error subiendo miniatura:", err);
                    return null; // Si falla la miniatura, no cancelamos todo
                });
        });

    } else if (name === "file") {
        // 🎥 Si el campo se llama 'file', hacemos STREAMING (es grande)
        console.log(`📥 Recibiendo video: ${filename}`);
        fileName = filename;
        mimeType = mime;
        const fileSize = parseInt(req.headers['content-length'] || "0");
        
        // Iniciamos subida del video
        videoUploadPromise = uploadFromStream(file, filename, fileSize);
    } else {
        file.resume(); // Ignorar otros archivos
    }
  });

  bb.on('close', async () => {
    if (!videoUploadPromise) {
        return res.status(400).json({ error: "No se envió el archivo de video ('file')" });
    }

    try {
        // Esperamos a que el Video Y la Miniatura terminen de subir
        const [videoResult, thumbId] = await Promise.all([videoUploadPromise, thumbUploadPromise]);

        // Guardamos en la "Base de Datos"
        const files = readJSON(FILES_FILE);
        files.push({
            id: Date.now(),
            user_id: req.user.id,
            name: fileName,
            mime: mimeType,
            thumbnail_id: thumbId, // <--- AQUÍ GUARDAMOS EL ID DE LA MINIATURA
            telegram_id: videoResult.telegram_id,
            message_id: videoResult.message_id,
            created_at: new Date()
        });
        writeJSON(FILES_FILE, files);

        res.json({ ok: true, message: "Video y Miniatura subidos correctamente" });
    } catch (err) {
        console.error("Error finalizando subida:", err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  req.pipe(bb);
});

// ... (Resto de rutas igual: /files, /file-url, /stream)
app.get("/files", authMiddleware, (req, res) => {
    const files = readJSON(FILES_FILE).filter(f => f.user_id === req.user.id);
    res.json(files);
  });
  
  app.get("/file-url/:file_id", authMiddleware, async (req, res) => {
      try {
          const url = await getFileUrl(req.params.file_id); 
          res.json({ url });
      } catch (error) {
          res.status(500).json({ error: "Error URL" });
      }
  });
  
  app.get("/stream/:message_id", authMiddleware, async (req, res) => {
      try {
          const fileData = readJSON(FILES_FILE).find(f => f.message_id == req.params.message_id);
          if (fileData) res.setHeader('Content-Type', fileData.mime);
          await streamFile(req.params.message_id, res);
      } catch (error) {
          if (!res.headersSent) res.status(500).end();
      }
  });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));