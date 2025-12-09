import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { uploadFile } from "./uploader.js";

const app = express();
app.use(cors());
app.use(express.json());

// Carpeta temporal para uploads
const uploadDir = path.join(process.cwd(), "temp_uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// Middleware de autenticación
export function authMiddleware(req, res, next) {
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

// Endpoint upload
app.post("/upload", authMiddleware, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se subió ningún archivo" });

  try {
    // Subir archivo a Telegram + generar miniatura
    const result = await uploadFile(req.file);

    // Aquí puedes guardar en tu DB o JSON si quieres historial
    // Ejemplo:
    /*
    files.push({
      user_id: req.user.id,
      name: result.name,
      fileId: result.fileId,
      thumbId: result.thumbId,
      type: result.type,
      created_at: new Date()
    });
    */

    // Devolver info al frontend para mostrar miniatura
    res.json({
      ok: true,
      fileId: result.fileId,
      thumbId: result.thumbId,
      name: result.name,
      type: result.type
    });
  } catch (err) {
    console.error("Error subiendo archivo:", err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// Endpoint para servir miniaturas
app.get("/thumbnail/:thumbId", authMiddleware, async (req, res) => {
  const thumbId = req.params.thumbId;
  try {
    // Descargar miniatura desde Telegram usando tu uploader.js
    const buffer = await uploadFile.client.downloadFile(thumbId); 
    res.setHeader("Content-Type", "image/jpeg");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "No se pudo descargar la miniatura" });
  }
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor iniciado en puerto ${PORT}`));
