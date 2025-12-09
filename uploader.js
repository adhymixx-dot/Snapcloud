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
 * 🔑 Estrategia robusta: Obtener file_id usando la Bot API (forwardMessage).
 */
async function getTelegramFileId(messageId, channelIdBigInt) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");

    const channelIdStr = channelIdBigInt.toString(); 
    
    // 1. Reenviamos el mensaje al mismo canal usando el Bot
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`;
    const params = {
        chat_id: channelIdStr,
        from_chat_id: channelIdStr,
        message_id: messageId
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
        throw err;
    }
}

// --- FUNCIONES DE EXPORTACIÓN ---

/**
 * 🚀 Sube el archivo original y devuelve un objeto con el file_id correcto y message_id.
 */
export async function uploadToTelegram(file) {
  try {
    await initClient(); 
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
        message_id: messageResult.id // Este ID es CRUCIAL para el streaming
    };
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

/**
 * 🖼️ Sube la miniatura y devuelve un objeto con el file_id correcto y message_id.
 */
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

/**
 * 🔗 Obtiene la URL de descarga de la CDN de Telegram (USA LA API HTTP DEL BOT).
 * Funciona solo para archivos < 20MB (miniaturas/imágenes pequeñas).
 */
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

/**
 * 🎥 STREAMING: Descarga el archivo usando el Cliente de Usuario (sin límite de tamaño)
 * y lo escribe directamente en la respuesta del servidor (res).
 */
export async function streamFile(messageId, res) {
    await initClient();

    // 1. Obtenemos el mensaje original para acceder al medio
    const messages = await client.getMessages(chatId, { ids: [Number(messageId)] });
    const message = messages[0];

    if (!message || !message.media) {
        throw new Error("Mensaje o archivo no encontrado en Telegram");
    }

    const media = message.media.document || message.media.video || message.media.photo;
    
    // 2. Usamos iterDownload para bajarlo por pedazos y enviarlo al navegador
    const stream = client.iterDownload(media, {
        chunkSize: 128 * 1024, // 128KB chunks
    });
    
    // Si el cliente cierra la conexión, terminamos el stream.
    res.on('close', () => {
         // Aseguramos que no haya más escritura si el cliente se desconecta
         res.end(); 
    });

    for await (const chunk of stream) {
        // Escribimos cada pedazo en la respuesta HTTP
        res.write(chunk);
    }
    
    res.end();
}