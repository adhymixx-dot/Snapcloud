import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy";
import { createClient } from "@supabase/supabase-js";
import { uploadFromStream, uploadThumbnailBuffer, getFileUrl, streamFile } from "./uploader.js";

const app = express();
app.use(cors({ origin: "*" })); 
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "secreto";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split("Bearer ")[1] || req.query.token;
    if (!token) return res.status(401).json({ error: "No autorizado" });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; 
        next();
    } catch (err) { res.status(401).json({ error: "Token inválido" }); }
}

// --- RUTAS AUTH ---
app.post("/register", async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();
        if (existing) return res.status(400).json({ error: "Ya existe" });
        const hash = await bcrypt.hash(password, 10);
        await supabase.from('users').insert([{ email, password: hash }]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Error registro" }); }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if (!user || !await bcrypt.compare(password, user.password)) return res.status(400).json({ error: "Error login" });
        const token = jwt.sign({ id: user.id }, JWT_SECRET);
        res.json({ ok: true, token });
    } catch (e) { res.status(500).json({ error: "Error login" }); }
});

// --- UPLOAD ---
app.post("/upload", authMiddleware, (req, res) => {
    const bb = busboy({ headers: req.headers });
    let vidP = null, thP = Promise.resolve(null);
    let fName = "", mime = "";
    
    // Capturamos el tamaño (IMPORTANTE PARA BARRA DE CARGA)
    const fileSize = parseInt(req.headers['content-length'] || "0");

    bb.on('file', (name, file, info) => {
        if (name === "thumbnail") {
            const c = []; file.on('data', d => c.push(d));
            file.on('end', () => thP = uploadThumbnailBuffer(Buffer.concat(c)).catch(()=>null));
        } else if (name === "file") {
            fName = info.filename; mime = info.mimeType;
            vidP = uploadFromStream(file, info.filename, fileSize);
        } else { file.resume(); }
    });

    bb.on('close', async () => {
        if (!vidP) return res.status(400).json({ error: "Falta archivo" });
        try {
            const [vid, th] = await Promise.all([vidP, thP]);
            let tId = th ? (th.message_id || th) : null;
            if (typeof tId === 'object') tId = JSON.stringify(tId);

            await supabase.from('files').insert([{
                user_id: req.user.id, name: fName, mime: mime, size: fileSize,
                thumbnail_id: tId ? String(tId) : null,
                telegram_id: String(vid.telegram_id), message_id: String(vid.message_id)
            }]);
            res.json({ ok: true });
        } catch (e) { console.error(e); if(!res.headersSent) res.status(500).json({ error: e.message }); }
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

app.get("/stream/:message_id", authMiddleware, async (req, res) => {
    try {
        const { data: f } = await supabase.from('files').select('mime, name').eq('message_id', req.params.message_id).single();
        const range = req.headers.range;
        if (f) {
            res.setHeader('Content-Type', f.mime);
            res.setHeader('Content-Disposition', `inline; filename="${f.name}"`);
        }
        await streamFile(req.params.message_id, res, range);
    } catch (error) {
        console.error("❌ Error Stream:", error);
        if (!res.headersSent) res.status(500).end();
    }
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Server Ready"));