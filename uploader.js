import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import path from "path";

// 1. Configuración del CLIENTE (Archivos Grandes)
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = BigInt(process.env.TELEGRAM_CHANNEL_ID); // Canal del usuario (archivos grandes)

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientStarted = false;
async function initClient() {
  if (clientStarted) return;
  await client.connect();
  clientStarted = true;
  console.log("Telegram CLIENTE conectado.");
}

// 2. Configuración del Canal de Bot (Miniaturas)
const botChatId = BigInt(process.env.BOT_CHANNEL_ID); // Canal del bot (miniaturas)

// --- Funciones de Exportación ---

/**
 * Sube el archivo original al canal principal.
 */
export async function uploadToTelegram(file) {
  try {
    await initClient();
    const result = await client.sendFile(chatId, { file: file.path, caption: "SnapCloud upload" });
    console.log("Archivo GRANDE subido:", result.id || result);
    return result;
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

/**
 * Sube la miniatura al canal del bot.
 */
export async function uploadThumbnail(thumbPath) {
  try {
    await initClient(); // Usa el mismo cliente
    const result = await client.sendFile(botChatId, { 
        file: thumbPath, 
        caption: "SnapCloud thumbnail",
        forceDocument: false // Permitir que Telegram lo trate como foto/video si aplica
    });
    console.log("Miniatura subida:", result.id || result);
    return result;
  } catch (err) {
    console.error("Error subiendo miniatura a Telegram:", err);
    throw err;
  }
}

// Función para obtener la URL de un archivo desde Telegram (requiere el BOT_TOKEN)
// NOTA: Usar el cliente es difícil para obtener la URL de descarga directa. 
// Es mucho mejor usar la API HTTP de un Bot para esto.
const BOT_TOKEN = process.env.BOT_TOKEN;

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");

    try {
        // PASO 1: Obtener la ruta del archivo (file_path)
        const responsePath = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const dataPath = await responsePath.json();
        
        if (!dataPath.ok) throw new Error(dataPath.description || "Error al obtener la ruta del archivo de Telegram.");

        const filePath = dataPath.result.file_path;

        // PASO 2: Construir la URL de descarga de la CDN de Telegram
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        return fileUrl;

    } catch (error) {
        console.error("Error en getFileUrl:", error.message);
        throw error;
    }
}