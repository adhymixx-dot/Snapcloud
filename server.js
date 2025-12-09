import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { uploadToTelegram } from "./uploader.js"; // tu uploader que sube al bot y canal
import ffmpeg from "fluent-ffmpeg";

const app = express();
app.use(cors());
app.use(express.json());

// Carpetas temporales
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, Date.now() + "_" + file.originalname)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
});

// JSON local
const USERS_FILE = path.join(process.cwd(), "users.json");
const FILES_FILE = path.join(process.cwd(), "files.json");

// JWT
const JWT_SECRET = process.env.JWT_SECRET || "clave_super_secreta";

// Leer / escribir JSON
function readJSON(file){ return fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[]; }
function writeJSON(file,data){ fs.writeFileSync(file,JSON.stringify(data,null,2)); }

// Middleware auth
function authMiddleware(req,res,next){
  const token=req.headers["authorization"]?.split("Bearer ")[1];
  if(!token) return res.status(401).json({ error:"No autorizado" });
  try{
    const payload=jwt.verify(token,JWT_SECRET);
    req.user=payload;
    next();
  }catch{
    return res.status(401).json({ error:"Token inválido" });
  }
}

// Registro
app.post("/register", async(req,res)=>{
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({error:"Email y password son requeridos"});
  const users=readJSON(USERS_FILE);
  if(users.find(u=>u.email===email)) return res.status(400).json({error:"Usuario ya existe"});
  const hash=await bcrypt.hash(password,10);
  users.push({id:Date.now().toString(),email,password:hash});
  writeJSON(USERS_FILE,users);
  res.json({ok:true,message:"Usuario registrado"});
});

// Login
app.post("/login",async(req,res)=>{
  const {email,password}=req.body;
  const users=readJSON(USERS_FILE);
  const user=users.find(u=>u.email===email);
  if(!user) return res.status(400).json({error:"Usuario no encontrado"});
  const match=await bcrypt.compare(password,user.password);
  if(!match) return res.status(400).json({error:"Password incorrecto"});
  const token=jwt.sign({id:user.id,email:user.email},JWT_SECRET,{expiresIn:"7d"});
  res.json({ok:true,token});
});

// Subir archivo
app.post("/upload",authMiddleware,upload.single("file"),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:"No file provided"});
    const isVideo=req.file.mimetype.startsWith("video");

    // Subir archivo original al bot (canal del usuario)
    const originalResult=await uploadToTelegram(req.file,true); 

    let thumbResult=null;
    if(!isVideo){ // miniatura solo imágenes
      const thumbPath=path.join(uploadDir,"thumb_"+req.file.filename);
      await sharp(req.file.path).resize(300,300).toFile(thumbPath);
      thumbResult=await uploadToTelegram({path:thumbPath},false); // canal del bot
      fs.unlinkSync(thumbPath);
    } else { // miniatura video
      const thumbPath=path.join(uploadDir,"thumb_"+req.file.filename+".jpg");
      await new Promise((resolve,reject)=>{
        ffmpeg(req.file.path)
          .screenshots({count:1,folder:uploadDir,filename:"thumb_"+req.file.filename+".jpg",size:"300x?"})
          .on("end",resolve)
          .on("error",reject);
      });
      thumbResult=await uploadToTelegram({path:thumbPath},false);
      fs.unlinkSync(thumbPath);
    }

    // Guardar metadata
    const files=readJSON(FILES_FILE);
    files.push({
      user_id:req.user.id,
      fileId:originalResult.id,
      thumbId:thumbResult?.id || originalResult.id,
      type:isVideo?"video":"image",
      name:req.file.originalname,
      created_at:new Date()
    });
    writeJSON(FILES_FILE,files);

    fs.unlinkSync(req.file.path);
    res.json({ok:true,message:"Archivo subido"});
  }catch(err){
    console.error(err);
    if(req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({error:err.message||"Error subiendo archivo"});
  }
});

// Listar archivos del usuario
app.get("/files",authMiddleware,(req,res)=>{
  const files=readJSON(FILES_FILE).filter(f=>f.user_id===req.user.id);
  res.json(files);
});

// Devolver URL segura de archivo o miniatura
app.get("/file/:fileId",authMiddleware,async(req,res)=>{
  const files=readJSON(FILES_FILE);
  const file=files.find(f=>f.fileId===req.params.fileId || f.thumbId===req.params.fileId);
  if(!file) return res.status(404).json({error:"Archivo no encontrado"});
  // Aquí devolvemos la URL pública que da Telegram para el fileId
  // Suponiendo que uploadToTelegram devuelve {id, url}
  res.json({url:file.thumbUrl || file.fileUrl || `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.fileId}`});
});

// Servidor
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Servidor en puerto ${PORT}`));
