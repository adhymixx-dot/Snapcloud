import 'dotenv/config';
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { uploadToTelegram } from "./uploader.js"; // tu uploader de Telegram
import sharp from "sharp"; // para miniaturas de imagen
import ffmpeg from "fluent-ffmpeg"; // para miniaturas de video

const app = express();
app.use(express.json());

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

// Ruta para subir archivo
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  try {
    // Subir a Telegram
    const result = await uploadToTelegram(req.file);

    // Crear miniatura
    const ext = path.extname(req.file.filename).toLowerCase();
    const thumbPath = path.join(thumbDir, req.file.filename + ".jpg");

    if (/\.(jpg|jpeg|png|gif)$/i.test(ext)) {
      await sharp(req.file.path).resize(200).toFile(thumbPath);
    } else if (/\.(mp4|mov|webm)$/i.test(ext)) {
      // Extraer primer frame con ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(req.file.path)
          .screenshots({ timestamps: ['50%'], filename: req.file.filename + '.jpg', folder: thumbDir, size: '200x?' })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    res.json({
      ok: true,
      fileId: result.id || result,
      filename: req.file.filename,
      thumb: `/thumbnails/${req.file.filename}.jpg`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// Servir miniaturas
app.use("/thumbnails", express.static(thumbDir));

// Puerto
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
