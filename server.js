import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { createClient } from "@supabase/supabase-js";
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
const JWT_SECRET = process.env.JWT_SECRET || "secreto_super_seguro";

// --- CONFIGURACIÓN SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ ERROR: Faltan variables de SUPABASE en Render.");
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// --- MIDDLEWARE DE AUTH ---
function authMiddleware(req, res, next) {
    // Busca token en Header O en la URL (importante para el reproductor de video)
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

// --- RUTAS DE USUARIO ---

app.post("/register", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Faltan datos" });

    try {
        const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
        if (existing) return res.status(400).json({ error: "El correo ya está registrado" });

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
        const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single();
        if (error || !user || !await bcrypt.compare(password, user.password)) {
            return res.status(400).json({ error: "Credenciales incorrectas" });
        }
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
        res.json({ ok: true, token });
    } catch (error) {
        res.status(500).json({ error: "Error en login" });
    }
});

// --- RUTAS DE ARCHIVOS ---

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
                const buffer = Buffer.concat(chunks);
                if (buffer.length > 0) {
                    thumbUploadPromise = uploadThumbnailBuffer(buffer).catch(e => {
                        console.error("Error subiendo miniatura:", e);
                        return null;
                    });
                }
            });
        } else if (name === "file") {
            console.log(`📥 Recibiendo archivo principal: ${filename}`);
            fileName = filename;
            mimeType = mime;
            const fileSize = parseInt(req.headers['content-length'] || "0");
            videoUploadPromise = uploadFromStream(file, filename, fileSize);
        } else {
            file.resume();
        }
    });

    bb.on('close', async () => {
        if (!videoUploadPromise) return res.status(400).json({ error: "Falta el archivo principal" });

        try {
            const [videoResult, thumbResult] = await Promise.all([videoUploadPromise, thumbUploadPromise]);

            // Limpieza del ID de la miniatura
            let cleanThumbId = null;
            if (thumbResult) {
                cleanThumbId = thumbResult.message_id || thumbResult;
                if (typeof cleanThumbId === 'object') cleanThumbId = JSON.stringify(cleanThumbId);
            }

            // Insertar en Supabase
            const { error } = await supabase.from('files').insert([{
                user_id: req.user.id,
                name: fileName,
                mime: mimeType,
                thumbnail_id: cleanThumbId ? String(cleanThumbId) : null,
                telegram_id: videoResult.telegram_id ? String(videoResult.telegram_id) : null,
                message_id: videoResult.message_id ? String(videoResult.message_id) : null
            }]);

            if (error) throw error;

            res.json({ ok: true, message: "Subido exitosamente" });
        } catch (err) {
            console.error("Error en upload:", err);
            if (!res.headersSent) res.status(500).json({ error: err.message });
        }
    });

    req.pipe(bb);
});

app.get("/files", authMiddleware, async (req, res) => {
    try {
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
        res.status(500).json({ error: "Error URL" });
    }
});

// --- RUTA CORREGIDA PARA EL ERROR 500 ---
app.get("/stream/:message_id", authMiddleware, async (req, res) => {
    try {
        // 1. Convertir el ID de la URL (String) a Número (Integer)
        // Telegram necesita números, si le pasas texto falla.
        const messageId = parseInt(req.params.message_id);

        if (isNaN(messageId)) {
            console.error(`ID inválido recibido: ${req.params.message_id}`);
            return res.status(400).json({ error: "ID de archivo inválido" });
        }

        // 2. Obtener tipo de archivo (MIME) de Supabase para el navegador
        const { data: fileData } = await supabase
            .from('files')
            .select('mime')
            .eq('message_id', messageId.toString()) // Buscamos en BD
            .maybeSingle();

        if (fileData && fileData.mime) {
            res.setHeader('Content-Type', fileData.mime);
        }

        // 3. Iniciar descarga desde Telegram usando el ID numérico
        await streamFile(messageId, res);

    } catch (error) {
        console.error("❌ Error CRÍTICO en stream:", error);
        if (!res.headersSent) res.status(500).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en puerto ${PORT}`));