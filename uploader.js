// uploader.js (Versión Robusta)

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import path from "path";

// Función de seguridad para asegurar que las variables de canal existen
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        // Lanza un error claro que se verá en la consola de Render
        throw new Error(`CRITICAL ERROR: Environment variable ${varName} is missing or empty. The server cannot start.`);
    }
    // Devuelve el valor como BigInt
    return BigInt(value);
}

// 1. Configuración del CLIENTE (Archivos Grandes)
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// Usa la función robusta para TELEGRAM_CHANNEL_ID
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 

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
// Usa la función robusta para BOT_CHANNEL_ID
const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); 

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
        forceDocument: false
    });
    console.log("Miniatura subida:", result.id || result);
    return result;
  } catch (err) {
    console.error("Error subiendo miniatura a Telegram:", err);
    throw err;
  }
}

// Función para obtener la URL de un archivo desde Telegram
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