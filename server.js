import express from "express";
import multer from "multer";
import cors from "cors"; // 🔹 Importar cors
import { uploadToTelegram } from "./uploader.js";

const app = express();
app.use(express.json());

// 🔹 Habilitar CORS para tu frontend
app.use(cors({
    origin: "https://snapcloud.netlify.app", // reemplaza con la URL de tu Netlify
    methods: ["GET","POST"]
}));

// Multer en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

app.get("/", (req, res) => {
  res.send("SnapCloud Backend funcionando!");
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    const result = await uploadToTelegram(req.file);

    res.json({
      ok: true,
      fileId: result.id || result,
      message: "Archivo subido correctamente"
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error subiendo archivo" });
  }
});

// Puerto asignado por Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor iniciado en puerto " + PORT));
