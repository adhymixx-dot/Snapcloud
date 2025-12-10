import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { createClient } from "@supabase/supabase-js"; // <--- NUEVO
import { uploadFromStream, uploadThumbnailBuffer, getFileUrl, streamFile } from "./uploader.js";

// --- CONFIGURACIÓN SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL || "TU_SUPABASE_URL_AQUI";
const supabaseKey = process.env.SUPABASE_KEY || "TU_SUPABASE_ANON_KEY_AQUI";
const supabase = createClient(supabaseUrl, supabaseKey);

// --- INICIO APP ---
const app = express();
const allowedOrigins = ["https://snapcloud.netlify.app", "http://localhost:5173", "http://localhost:3000"];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('No permitido por CORS'));
  }
}));

app.use(express.json());
const JWT_SECRET = process.env.JWT_SECRET || "secreto_super_seguro";

// --- MIDDLEWARE DE AUTH ---
// Busca el token en Header O en la URL (para ver videos)
function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split("Bearer ")[1] || req.query.token;
    if (!token) return res.status(401).json({ error: "No auth" });
  
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; 
        next();
    } catch (err) {
        res.status(401).json({ error: "Token inválido" });
    }
}

// --- RUTAS ---

app.post("/register", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Faltan datos" });

    try {
        // 1. Verificar si existe
        const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
        if (existing) return res.status(400).json({ error: "El correo ya está registrado" });

        // 2. Crear usuario
        const hash = await bcrypt.hash(password, 10);
        const { error } = await supabase.from('users').insert([{ email, password: hash }]);
        
        if (error) throw error;
        res.json({ ok: true, message: "Usuario creado" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Error al registrar" });
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    
    try {
        // 1. Buscar usuario en Supabase
        const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
        
        if (error || !user || !await bcrypt.compare(password, user.password)) {
            return res.status(400).json({ error: "Credenciales incorrectas" });
        }

        // 2. Generar token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
        res.json({ ok: true, token });
    } catch (error) {
        res.status(500).json({ error: "Error en login" });
    }
});

app.post("/upload", authMiddleware, (req, res) => {
    const bb = busboy({ headers: req.headers });
    let videoUploadPromise = null;
    let thumbUploadPromise = Promise.resolve(null);
    let fileName = "";
    let mimeType = "";

    bb.on('file', (name, file, info) => {
        const { filename, mimeType: mime } = info;

        if (name === "thumbnail") {
            const chunks = [];
            file.on('data', chunk => chunks.push(chunk));
            file.on('end', () => {
                thumbUploadPromise = uploadThumbnailBuffer(Buffer.concat(chunks)).catch(e => null);
            });
        } else if (name === "file") {
            fileName = filename;
            mimeType = mime;
            const fileSize = parseInt(req.headers['content-length'] || "0");
            videoUploadPromise = uploadFromStream(file, filename, fileSize);
        } else {
            file.resume();
        }
    });

    bb.on('close', async () => {
        if (!videoUploadPromise) return res.status(400).json({ error: "Falta el video" });

        try {
            const [videoResult, thumbId] = await Promise.all([videoUploadPromise, thumbUploadPromise]);

            // Guardar registro en Supabase
            const { error } = await supabase.from('files').insert([{
                user_id: req.user.id,
                name: fileName,
                mime: mimeType,
                thumbnail_id: thumbId,
                telegram_id: videoResult.telegram_id,
                message_id: videoResult.message_id
            }]);

            if (error) throw error;

            res.json({ ok: true, message: "Subido exitosamente" });
        } catch (err) {
            console.error(err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.get("/files", authMiddleware, async (req, res) => {
    try {
        // Obtener archivos del usuario desde Supabase
        const { data: files, error } = await supabase
            .from('files')
            .select('*')
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: "Error al obtener archivos" });
    }
});

app.get("/file-url/:file_id", authMiddleware, async (req, res) => {
    try {
        const url = await getFileUrl(req.params.file_id);
        res.json({ url });
    } catch (error) {
        res.status(500).json({ error: "Error obteniendo URL" });
    }
});

app.get("/stream/:message_id", authMiddleware, async (req, res) => {
    try {
        // Buscar metadatos en Supabase para saber el MIME type
        const { data: fileData } = await supabase
            .from('files')
            .select('mime')
            .eq('message_id', req.params.message_id)
            .single();

        if (fileData) res.setHeader('Content-Type', fileData.mime);
        
        await streamFile(req.params.message_id, res);
    } catch (error) {
        console.error(error);
        if (!res.headersSent) res.status(500).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));