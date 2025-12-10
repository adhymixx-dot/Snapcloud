import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import busboy from "busboy"; // <--- NUEVO: Para manejar streams
// Importamos la nueva función uploadFromStream y las existentes
import { uploadFromStream, getFileUrl, streamFile } from "./uploader.js"; 

const app = express();

// Configuración de CORS
// IMPORTANTE: Agrega tu URL local para pruebas y la de Netlify
const allowedOrigins = ["https://snapcloud.netlify.app", "http://localhost:5173", "http://localhost:3000"];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error('No permitido por CORS'));
  }
}));

app.use(express.json());

// Archivos JSON (Base de datos temporal)
const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// --- FUNCIONES AUXILIARES DE "BASE DE DATOS" ---
function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`Error leyendo ${file}:`, e);
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// --- MIDDLEWARE DE AUTENTICACIÓN ---
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

// --- RUTAS DE USUARIO ---

// Registro
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

// Login
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


// 🚀 RUTA DE SUBIDA MODIFICADA (STREAMING PURO) 🚀
// Ya no usamos 'upload.single', usamos 'busboy' dentro de la ruta
app.post("/upload", authMiddleware, (req, res) => {
  const bb = busboy({ headers: req.headers });
  let uploadPromise = null;
  let fileReceived = false;

  // Evento cuando Busboy detecta un archivo en el formulario
  bb.on('file', (name, file, info) => {
    fileReceived = true;
    const { filename, mimeType } = info;
    
    // Intentamos obtener el tamaño del header (es un estimado)
    const fileSize = parseInt(req.headers['content-length'] || "0"); 

    console.log(`📥 Recibiendo stream de archivo: ${filename}`);

    // Llamamos a la función de uploader.js que conecta el stream con Telegram
    uploadPromise = uploadFromStream(file, filename, fileSize)
      .then(async (result) => {
         // Cuando termina de subir, guardamos los datos
         const files = readJSON(FILES_FILE);
         files.push({
           id: Date.now(),
           user_id: req.user.id,
           name: filename,
           mime: mimeType,
           thumbnail_id: null, // Sin miniatura en modo streaming puro
           telegram_id: result.telegram_id,
           message_id: result.message_id, // ID importante para ver el video después
           created_at: new Date()
         });
         writeJSON(FILES_FILE, files);
         return result;
      })
      .catch(err => {
        console.error("Error crítico en el stream:", err);
        throw err; // Lanzar para que lo capture el bb.on('close') o el manejador global
      });
  });

  // Evento cuando Busboy termina de procesar todo el formulario
  bb.on('close', async () => {
    if (!fileReceived) {
      return res.status(400).json({ error: "No se envió ningún archivo" });
    }

    if (uploadPromise) {
      try {
        await uploadPromise; // Esperamos a que termine la subida a Telegram
        res.json({ ok: true, message: "Archivo subido exitosamente (Stream Directo)" });
      } catch (err) {
        res.status(500).json({ error: err.message || "Error durante la subida" });
      }
    }
  });

  // Manejo de errores de Busboy
  bb.on('error', (err) => {
      console.error('Error en Busboy:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error procesando la carga" });
      }
  });

  // Conectar el flujo de la petición HTTP a Busboy
  req.pipe(bb);
});

// --- OTRAS RUTAS ---

// Listar archivos del usuario
app.get("/files", authMiddleware, (req, res) => {
  const files = readJSON(FILES_FILE).filter(f => f.user_id === req.user.id);
  res.json(files);
});

// Obtener URL de descarga directa (CDN Telegram) - Solo archivos pequeños
app.get("/file-url/:file_id", authMiddleware, async (req, res) => {
    try {
        const fileId = req.params.file_id;
        const url = await getFileUrl(fileId); 
        res.json({ url });
    } catch (error) {
        console.error("Error en /file-url:", error.message);
        res.status(500).json({ error: error.message || "Error al obtener URL" });
    }
});

// Streaming de descarga (Ver videos grandes)
app.get("/stream/:message_id", authMiddleware, async (req, res) => {
    try {
        const messageId = req.params.message_id;

        const files = readJSON(FILES_FILE);
        const fileData = files.find(f => f.message_id == messageId);

        if (!fileData) {
            return res.status(404).json({ error: "Archivo no encontrado en base de datos" });
        }
        
        // Headers para que el navegador sepa que es un video/archivo
        res.setHeader('Content-Type', fileData.mime);
        // Opcional: Content-Disposition para forzar descarga o nombre
        // res.setHeader('Content-Disposition', `inline; filename="${fileData.name}"`);

        await streamFile(messageId, res);
    } catch (error) {
        console.error("Error en streaming descarga:", error.message);
        if (!res.headersSent) {
            res.status(500).json({ error: "Error en el streaming del archivo" });
        } else {
            res.end();
        }
    }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SnapCloud iniciado en puerto ${PORT}`));