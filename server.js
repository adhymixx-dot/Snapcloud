import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { createClient } from "@supabase/supabase-js";
import { uploadFromStream, uploadThumbnailBuffer, getFileUrl, streamFile } from "./uploader.js";

const app = express();
app.use(cors({ origin: "*" })); // Permitir acceso desde cualquier lado
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "secreto_super_seguro";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split("Bearer ")[1] || req.query.token;
    if (!token) return res.status(401).json({ error: "No auth" });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; 
        next();
    } catch (err) { res.status(401).json({ error: "Token inválido" }); }
}

// --- RUTAS DE AUTH Y SUBIDA (Iguales que antes) ---
app.post("/register", async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Faltan datos" });
    try {
        const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
        if (existing) return res.status(400).json({ error: "Registrado ya" });
        const hash = await bcrypt.hash(password, 10);
        await supabase.from('users').insert([{ email, password: hash }]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Error registro" }); }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Error credenciales" });
        const token = jwt.sign({ id: user.id }, JWT_SECRET);
        res.json({ ok: true, token });
    } catch (e) { res.status(500).json({ error: "Error login" }); }
});

app.post("/upload", authMiddleware, (req, res) => {
    const bb = busboy({ headers: req.headers });
    let videoPromise = null, thumbPromise = Promise.resolve(null);
    let fileName = "", mimeType = "";

    bb.on('file', (name, file, info) => {
        if (name === "thumbnail") {
            const chunks = [];
            file.on('data', c => chunks.push(c));
            file.on('end', () => thumbPromise = uploadThumbnailBuffer(Buffer.concat(chunks)).catch(()=>null));
        } else if (name === "file") {
            fileName = info.filename; mimeType = info.mimeType;
            videoPromise = uploadFromStream(file, info.filename, parseInt(req.headers['content-length'] || "0"));
        } else { file.resume(); }
    });

    bb.on('close', async () => {
        if (!videoPromise) return res.status(400).json({ error: "Falta archivo" });
        try {
            const [vid, thumb] = await Promise.all([videoPromise, thumbPromise]);
            let tId = thumb ? (thumb.message_id || thumb) : null;
            if (typeof tId === 'object') tId = JSON.stringify(tId);

            await supabase.from('files').insert([{
                user_id: req.user.id, name: fileName, mime: mimeType,
                thumbnail_id: tId ? String(tId) : null,
                telegram_id: String(vid.telegram_id), message_id: String(vid.message_id)
            }]);
            res.json({ ok: true });
        } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
    });
    req.pipe(bb);
});

app.get("/files", authMiddleware, async (req, res) => {
    const { data } = await supabase.from('files').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
    res.json(data);
});

app.get("/file-url/:file_id", authMiddleware, async (req, res) => {
    const url = await getFileUrl(req.params.file_id);
    res.json({ url });
});

// --- RUTA DE VISUALIZACIÓN (STREAMING) ---
app.get("/stream/:message_id", authMiddleware, async (req, res) => {
    try {
        console.log(`📡 Reproduciendo mensaje: ${req.params.message_id}`);
        const { data: fileData } = await supabase.from('files').select('mime, name').eq('message_id', req.params.message_id).single();

        if (fileData) {
            res.setHeader('Content-Type', fileData.mime);
            // ESTA LÍNEA ES LA CLAVE PARA QUE NO SE DESCARGUE:
            res.setHeader('Content-Disposition', `inline; filename="${fileData.name}"`);
        }

        await streamFile(req.params.message_id, res);
    } catch (error) {
        console.error("❌ Error Stream:", error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server listo"));