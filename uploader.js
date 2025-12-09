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
    // Asegura que BigInt se usa para los IDs
    return BigInt(value);
}

// --- CONFIGURACIÓN DEL CLIENTE ÚNICO (USUARIO) ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// ID del Canal principal donde sube el usuario (para archivos grandes)
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
// ID del Canal donde sube el usuario las miniaturas
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
 * Esto requiere el objeto de mensaje completo de Telegram.
 */
async function getTelegramFileId(messageResult) {
    await initClient(); // Asegura que el cliente de usuario esté conectado

    if (!messageResult || !messageResult.media) {
        throw new Error("El resultado del mensaje de Telegram está incompleto para extraer el file_id.");
    }
    
    let fileMedia = messageResult.media.document || messageResult.media.photo || messageResult.media.video;

    if (!fileMedia) {
         throw new Error("No se encontró Documento, Foto o Video en el objeto media.");
    }

    // Para fotos, necesitamos el "PhotoSize" más grande
    if (messageResult.media.photo) {
        fileMedia = messageResult.media.photo.sizes.reduce((prev, current) => {
            return (prev.size.value || prev.size) > (current.size.value || current.size) ? prev : current;
        });
    }

    // El ID de archivo que la API del Bot necesita se genera a partir de estos campos:
    const fileId = new Api.InputFileLocation({
        id: fileMedia.id,
        accessHash: fileMedia.accessHash,
        fileReference: fileMedia.fileReference || Buffer.from([]),
        // Aquí no necesitamos los demás campos porque es un archivo ya subido
    });
    
    // Convertimos el InputFileLocation a un file_id codificado en Base64, 
    // que es el formato que requiere la API HTTP del Bot (getFile).
    return client.session.get.telegram.utils.getFileIdForStore(fileId);
}

// --- FUNCIONES DE EXPORTACIÓN ---

/**
 * 🚀 Sube el archivo original al canal principal (USA EL CLIENTE/USUARIO) y devuelve el file_id.
 */
export async function uploadToTelegram(file) {
  try {
    await initClient(); 
    // Usamos forceDocument: true para asegurar que el archivo completo se suba.
    const messageResult = await client.sendFile(chatId, { 
        file: file.path, 
        caption: "SnapCloud upload", 
        forceDocument: true 
    });
    console.log("Archivo GRANDE subido. ID de Mensaje:", messageResult.id);

    // ✅ PASO ADICIONAL: Obtenemos el file_id correcto
    const fileId = await getTelegramFileId(messageResult);
    return { 
        telegram_id: fileId, // El ID largo y correcto
        message_id: messageResult.id // El ID corto del mensaje
    };
  } catch (err) {
    console.error("Error subiendo archivo GRANDE a Telegram:", err);
    throw err;
  }
}

/**
 * 🖼️ Sube la miniatura al canal del bot (USA EL CLIENTE/USUARIO) y devuelve el file_id.
 */
export async function uploadThumbnail(thumbPath) {
  try {
    await initClient(); 
    const messageResult = await client.sendFile(botChatId, { 
        file: thumbPath, 
        caption: "SnapCloud thumbnail",
        forceDocument: false // Permitir que se suba como foto
    });
    console.log("Miniatura subida. ID de Mensaje:", messageResult.id);

    // ✅ PASO ADICIONAL: Obtenemos el file_id correcto
    const fileId = await getTelegramFileId(messageResult);
    return { 
        telegram_id: fileId, // El ID largo y correcto
        message_id: messageResult.id // El ID corto del mensaje
    };
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