import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { uploadToTelegram } from "./uploader.js";

const app = express();
app.use(cors());
app.use(express.json());

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb)=> cb(null, Date.now()+"_"+file.originalname) }) });

const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

function readJSON(file){ if(!fs.existsSync(file)) return []; return JSON.parse(fs.readFileSync(file)); }
function writeJSON(file,data){ fs.writeFileSync(file, JSON.stringify(data,null,2)); }

function authMiddleware(req,res,next){
  const token = req.headers["authorization"]?.split("Bearer ")[1];
  if(!token) return res.status(401).json({error:"No autorizado"});
  try{ req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch{ return res.status(401).json({error:"Token inválido"}); }
}

// Registro
app.post("/register", async (req,res)=>{
  const { email,password } = req.body;
  if(!email||!password) return res.status(400).json({error:"Email y password requeridos"});
  const users = readJSON(USERS_FILE);
  if(users.find(u=>u.email===email)) return res.status(400).json({error:"Usuario ya existe"});
  const hash = await bcrypt.hash(password,10);
  users.push({id:Date.now(),email,password:hash});
  writeJSON(USERS_FILE,users);
  res.json({ok:true});
});

// Login
app.post("/login", async (req,res)=>{
  const { email,password } = req.body;
  const users = readJSON(USERS_FILE);
  const user = users.find(u=>u.email===email);
  if(!user) return res.status(400).json({error:"Usuario no encontrado"});
  const match = await bcrypt.compare(password,user.password);
  if(!match) return res.status(400).json({error:"Password incorrecto"});
  const token = jwt.sign({id:user.id,email:user.email},JWT_SECRET,{expiresIn:"7d"});
  res.json({ok:true,token});
});

// Subir archivo
app.post("/upload", authMiddleware, upload.single("file"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"No file"});
  try{
    const result = await uploadToTelegram(req.file);
    const files = readJSON(FILES_FILE);
    files.push({
      user_id: req.user.id,
      name: req.file.originalname,
      type: req.file.mimetype.startsWith("image/")?"image":"video",
      fileId: result.originalId,
      thumbId: result.thumbId,
      created_at: new Date()
    });
    writeJSON(FILES_FILE,files);
    res.json({ok:true});
  }catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// Obtener archivos
app.get("/files", authMiddleware, (req,res)=>{
  const files = readJSON(FILES_FILE).filter(f=>f.user_id===req.user.id);
  res.json(files);
});

app.listen(process.env.PORT||3000, ()=>console.log("Servidor iniciado"));
