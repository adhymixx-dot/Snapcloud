import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        throw new Error(`CRITICAL ERROR: Environment variable ${varName} is missing or empty.`);
    }
    return BigInt(value);
}

// --- CONFIGURACIÓN ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// ID de canales
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); 
// Token del Bot
const BOT_TOKEN = process.env.BOT_TOKEN;

// Cliente de Usuario (MTProto)
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
 * 🔑 NUEVA ESTRATEGIA: Obtener file_id usando la API del Bot (forwardMessage).
 * Esto garantiza un ID compatible 100% con la API de descarga.
 */
async function getTelegramFileId(messageId, channelIdBigInt) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");

    // Convertir BigInt a String para la API HTTP
    const channelIdStr = channelIdBigInt.toString(); 
    // Nota: Para la API del Bot, los canales deben empezar con -100.
    // GramJS usa BigInts que ya incluyen el -100 o no, asegúrate de que tu variable de entorno lo tenga.
    
    // 1. Reenviamos el mensaje al mismo canal usando el Bot
    // (Usamos el mismo canal como destino temporal)
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`;
    const params = {
        chat_id: channelIdStr,      // Destino (mismo canal)
        from_chat_id: channelIdStr, // Origen (mismo canal)
        message_id: messageId       // ID del mensaje que acabamos de subir
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();

        if (!data.ok) {
            throw new Error(`Error Bot API forwardMessage: ${data.description}`);
        }

        const forwardedMsg = data.result;
        
        // 2. Extraer el file_id del mensaje reenviado
        let fileId = null;
        if (forwardedMsg.document) {
            fileId = forwardedMsg.document.file_id;
        } else if (forwardedMsg.video) {
            fileId = forwardedMsg.video.file_id;
        } else if (forwardedMsg.photo) {
            // La foto es un array, tomamos la última (más grande)
            fileId = forwardedMsg.photo[forwardedMsg.photo.length - 1].file_id;
        }

        if (!fileId) throw new Error("No se encontró file_id en el mensaje reenviado.");

        // 3. Borrar el mensaje reenviado (limpieza)
        const deleteUrl = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
        await fetch(deleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: channelIdStr,
                message_id: forwardedMsg.message_id
            })
        });

        return fileId;

    } catch (err) {
        console.error("Fallo al obtener file_id vía Bot API:", err);
        throw err; // Re-lanzar para manejar en server.js
    }
}

// --- FUNCIONES DE EXPORTACIÓN ---

export async function uploadToTelegram(file) {
  try {
    await initClient(); 
    // Subir como documento para preservar calidad y evitar compresión
    const messageResult = await client.sendFile(chatId, { 
        file: file.path, 
        caption: "SnapCloud upload", 
        forceDocument: true 
    });
    console.log("Archivo GRANDE subido. ID MTProto:", messageResult.id);

    // Obtener el ID compatible con Bot API
    const fileId = await getTelegramFileId(messageResult.id, chatId);
    
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
    console.log("Miniatura subida. ID MTProto:", messageResult.id);

    // Obtener el ID compatible con Bot API
    const fileId = await getTelegramFileId(messageResult.id, botChatId);
    
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
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");
    
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const responsePath = await fetch(url);
        const dataPath = await responsePath.json();
        
        if (!dataPath.ok) {
            const errorMessage = dataPath.description || "Error desconocido de Telegram.";
            console.error(`ERROR CRÍTICO getFile: ${errorMessage}`);
            throw new Error(`Telegram API Error: ${errorMessage}`);
        }

        const filePath = dataPath.result.file_path;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    } catch (error) {
        console.error("Error en getFileUrl:", error.message);
        throw error;
    }
}