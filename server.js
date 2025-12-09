import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        throw new Error(`CRITICAL ERROR: Environment variable ${varName} is missing or empty. The server cannot start.`);
    }
    return BigInt(value);
}

// --- 1. CONFIGURACIÓN DEL CLIENTE (USUARIO: Archivos Grandes) ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// ID del Canal principal donde sube el usuario
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 

const session = new StringSession(process.env.TELEGRAM_SESSION);
const userClient = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let userClientStarted = false;
async function initUserClient() {
  if (userClientStarted) return;
  await userClient.connect();
  userClientStarted = true;
  console.log("Telegram CLIENTE (Usuario) conectado.");
}

// --- 2. CONFIGURACIÓN DEL CLIENTE (BOT: Miniaturas) ---
// ID del Canal donde sube el bot las miniaturas
const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); 

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("CRITICAL ERROR: BOT_TOKEN is missing or empty.");

// Creamos un cliente GramJS para el Bot usando el Token
const botClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
});

let botClientStarted = false;
async function initBotClient() {
  if (botClientStarted) return;
  await botClient.start({ botAuthToken: BOT_TOKEN }); // Autenticación con el token
  botClientStarted = true;
  console.log("Telegram CLIENTE (Bot) conectado.");
}

// --- FUNCIONES DE EXPORTACIÓN ---

/**
 * 🚀 Sube el archivo original al canal principal (USA EL CLIENTE/USUARIO).
 */
export async function uploadToTelegram(file) {
  try {
    await initUserClient();
    const result = await userClient.sendFile(chatId, { file: file.path, caption: "SnapCloud upload" });
    console.log("Archivo GRANDE subido por USUARIO:", result.id || result);
    return result;
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

/**
 * 🖼️ Sube la miniatura al canal del bot (USA EL CLIENTE/BOT).
 */
export async function uploadThumbnail(thumbPath) {
  try {
    // Usar el cliente del Bot es más rápido para miniaturas
    await initBotClient(); 
    const result = await botClient.sendFile(botChatId, { 
        file: thumbPath, 
        caption: "SnapCloud thumbnail",
        forceDocument: false
    });
    console.log("Miniatura subida por BOT:", result.id || result);
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
    // Esta función sigue usando el BOT_TOKEN a través de la API HTTP REST.
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