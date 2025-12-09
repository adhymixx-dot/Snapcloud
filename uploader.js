import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import fs from "fs";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        throw new Error(`CRITICAL ERROR: Environment variable ${varName} is missing or empty.`);
    }
    return BigInt(value);
}

// --- CONFIGURACIÓN DEL CLIENTE ÚNICO (USUARIO) ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
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

/**
 * 🔑 Función crucial: Extrae el ID de archivo global (file_id) para la API HTTP del Bot.
 */
async function getTelegramFileId(messageResult) {
    await initClient();

    if (!messageResult || !messageResult.media) {
        throw new Error("El resultado del mensaje de Telegram está incompleto para extraer el file_id.");
    }
    
    let fileMedia = messageResult.media.document || messageResult.media.photo || messageResult.media.video;

    if (!fileMedia) {
         throw new Error("No se encontró Documento, Foto o Video en el objeto media.");
    }
    
    // CORRECCIÓN del TypeError: asegurar que seleccionamos el tamaño correcto de la foto.
    if (messageResult.media.photo) {
        const validSizes = messageResult.media.photo.sizes.filter(s => s && s.bytes); 
        
        if (validSizes.length === 0) {
            throw new Error("No se encontraron tamaños válidos para la foto (miniatura).");
        }
        
        fileMedia = validSizes.reduce((prev, current) => {
            return prev.bytes > current.bytes ? prev : current; 
        });
    }

    // Usamos el objeto fileMedia final (el documento, video o el tamaño de foto más grande)
    const fileId = new Api.InputFileLocation({
        id: fileMedia.id,
        accessHash: fileMedia.accessHash,
        fileReference: fileMedia.fileReference || Buffer.from([]),
    });
    
    // ✅ CORRECCIÓN FINAL: Acceso seguro a la utilidad de codificación de ID.
    const telegramUtils = client.session.get.telegram && client.session.get.telegram.utils;

    if (!telegramUtils || typeof telegramUtils.getFileIdForStore !== 'function') {
        throw new Error("CRÍTICO: No se pudo acceder a la utilidad interna de GramJS para codificar el ID de archivo. Intenta reiniciar el servicio.");
    }
    
    return telegramUtils.getFileIdForStore(fileId);
}

// --- FUNCIONES DE EXPORTACIÓN ---

export async function uploadToTelegram(file) {
  try {
    await initClient(); 
    const messageResult = await client.sendFile(chatId, { 
        file: file.path, 
        caption: "SnapCloud upload", 
        forceDocument: true 
    });
    console.log("Archivo GRANDE subido. ID de Mensaje:", messageResult.id);

    const fileId = await getTelegramFileId(messageResult);
    return { 
        telegram_id: fileId,
        message_id: messageResult.id 
    };
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

export async function uploadThumbnail(thumbPath) {
  try {
    await initClient(); 
    const messageResult = await client.sendFile(botChatId, { 
        file: thumbPath, 
        caption: "SnapCloud thumbnail",
        forceDocument: false 
    });
    console.log("Miniatura subida. ID de Mensaje:", messageResult.id);

    const fileId = await getTelegramFileId(messageResult);
    return { 
        telegram_id: fileId,
        message_id: messageResult.id 
    };
  } catch (err) {
    console.error("Error subiendo miniatura a Telegram:", err);
    throw err;
  }
}

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado para getFileUrl.");
    
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const responsePath = await fetch(url);
        const dataPath = await responsePath.json();
        
        if (!dataPath.ok) {
            const errorMessage = dataPath.description || "Respuesta de Telegram no fue OK y no contenía descripción del error.";
            console.error(`ERROR CRÍTICO al obtener file path para ID ${fileId}: Fallo de Telegram: ${errorMessage}`);
            throw new Error(`Fallo de Telegram: ${errorMessage}`);
        }

        const filePath = dataPath.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        return fileUrl;

    } catch (error) {
        console.error("Error en getFileUrl (Catch General):", error.message);
        throw error;
    }
}