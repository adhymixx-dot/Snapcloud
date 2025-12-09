import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        throw new Error(`ERROR CRÍTICO: La variable de entorno ${varName} no está configurada.`);
    }
    // Asegura que BigInt se usa para los IDs
    return BigInt(value);
}

// --- CONFIGURACIÓN DEL CLIENTE ÚNICO (USUARIO) ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// ID del Canal principal (para archivos grandes)
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
// ID del Canal donde sube el bot las miniaturas
const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); 
const BOT_TOKEN = process.env.BOT_TOKEN;

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientStarted = false;
async function initClient() {
  if (clientStarted) return;
  await client.connect();
  clientStarted = true;
  console.log("Telegram CLIENTE (Usuario Único) conectado.");
}

// --- FUNCIONES DE EXPORTACIÓN ---

/**
 * 🚀 Sube el archivo original al canal principal (USA EL CLIENTE/USUARIO).
 */
export async function uploadToTelegram(file) {
  try {
    await initClient(); 
    // Usamos forceDocument: true para forzar que los archivos se suban como documentos, 
    // asegurando que se suba el archivo completo.
    const result = await client.sendFile(chatId, { 
        file: file.path, 
        caption: "SnapCloud upload", 
        forceDocument: true 
    });
    console.log("Archivo GRANDE subido por USUARIO:", result.id || result);
    // OJO: La limpieza del archivo local la hace server.js, no la hagas aquí o fallará si hay un error.
    return result;
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

/**
 * 🖼️ Sube la miniatura al canal del bot (USA EL CLIENTE/USUARIO).
 */
export async function uploadThumbnail(thumbPath) {
  try {
    await initClient(); 
    const result = await client.sendFile(botChatId, { 
        file: thumbPath, 
        caption: "SnapCloud thumbnail",
        forceDocument: false // Permitir que se suba como foto
    });
    console.log("Miniatura subida por USUARIO a canal de Bot:", result.id || result);
    return result;
  } catch (err) {
    console.error("Error subiendo miniatura a Telegram:", err);
    throw err;
  }
}

/**
 * 🔗 Obtiene la URL de descarga de la CDN de Telegram (USA LA API HTTP DEL BOT).
 */
export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado para getFileUrl.");
    
    try {
        const responsePath = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const dataPath = await responsePath.json();
        
        if (!dataPath.ok) throw new Error(dataPath.description || "Error al obtener la ruta del archivo de Telegram.");

        const filePath = dataPath.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        return fileUrl;

    } catch (error) {
        console.error("Error en getFileUrl:", error.message);
        throw error;
    }
}