import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from 'buffer';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = new StringSession(process.env.TELEGRAM_SESSION);
const chatId = BigInt(process.env.TELEGRAM_CHANNEL_ID); 
const botChatId = BigInt(process.env.BOT_CHANNEL_ID || chatId);
const BOT_TOKEN = process.env.BOT_TOKEN;

const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
let clientPromise = null;

async function initClient() {
    if (!clientPromise) { 
        console.log("🔌 Telegram conectando..."); 
        clientPromise = client.connect(); 
    }
    await clientPromise;
}

// --- SUBIDA MANUAL (CORRIGE FILE_PART_SIZE_INVALID) ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    const fileId = BigInt(Date.now());
    const PART_SIZE = 512 * 1024; // 512KB EXACTOS (Obligatorio por Telegram)
    
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            
            // Solo enviamos si tenemos AL MENOS 512KB acumulados
            while (buffer.length >= PART_SIZE) {
                stream.pause(); // Pausar lectura mientras subimos
                
                const chunkToSend = buffer.slice(0, PART_SIZE);
                buffer = buffer.slice(PART_SIZE); // Guardar el sobrante
                
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: fileId,
                        filePart: partIndex,
                        fileTotalParts: -1, // Streaming mode
                        bytes: chunkToSend
                    }));
                    partIndex++;
                    stream.resume(); // Continuar leyendo
                } catch (err) {
                    console.error("Error subiendo parte:", err);
                    stream.destroy(err);
                    reject(err);
                }
            }
        });

        stream.on('end', async () => {
            // Enviar lo que sobró en el buffer (última parte)
            if (buffer.length > 0) {
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: fileId,
                        filePart: partIndex,
                        fileTotalParts: -1,
                        bytes: buffer
                    }));
                    partIndex++;
                } catch (err) { reject(err); }
            }
            resolve();
        });

        stream.on('error', (err) => reject(err));
    });

    // Finalizar subida enviando el archivo al chat
    const inputFile = new Api.InputFileBig({
        id: fileId,
        parts: partIndex,
        name: fileName
    });

    const res = await client.sendFile(chatId, {
        file: inputFile,
        forceDocument: true,
        caption: fileName
    });

    return { 
        telegram_id: await getTelegramFileId(res.id, chatId), 
        message_id: res.id 
    };
}

// --- VISUALIZACIÓN MANUAL (CORRIGE CANNOT CAST UNDEFINED) ---
// En lugar de iterDownload, usamos un bucle GetFile manual.
export async function streamFile(messageId, res) {
    await initClient();
    console.log(`🔍 Stream Manual ID: ${messageId}`);

    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Mensaje no encontrado");
    const msg = msgs[0];

    // 1. Construir la ubicación EXACTA
    let location = null;
    let fileSize = 0;
    let mimeType = "application/octet-stream";

    if (msg.media) {
        if (msg.media.document) {
            const doc = msg.media.document;
            fileSize = doc.size;
            mimeType = doc.mimeType;
            location = new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize: ""
            });
        } else if (msg.media.photo) {
            const photo = msg.media.photo;
            const size = photo.sizes[photo.sizes.length - 1]; // El más grande
            fileSize = size.size;
            mimeType = "image/jpeg";
            location = new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference,
                thumbSize: size.type
            });
        }
    }

    if (!location) throw new Error("No hay archivo válido en el mensaje.");

    // Configurar cabeceras correctas para streaming
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", fileSize);
    
    console.log(`▶️ Iniciando descarga directa (Tamaño: ${fileSize})`);

    // 2. Bucle de descarga manual (Chunk por Chunk)
    // Esto evita 'iterDownload' y sus errores de casting.
    const CHUNK_SIZE = 1024 * 1024; // Pedimos bloques de 1MB
    let offset = BigInt(0);
    
    try {
        while (true) {
            // Llamada directa a la API de Telegram (GetFile)
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: offset,
                limit: CHUNK_SIZE
            }));

            if (!result || result.bytes.length === 0) break;

            // Enviamos los bytes al navegador
            res.write(result.bytes);
            
            offset = offset + BigInt(result.bytes.length);

            // Si recibimos menos de lo que pedimos, es el final
            if (result.bytes.length < CHUNK_SIZE) break;
        }
        
        res.end();
        console.log("✅ Stream finalizado correctamente.");

    } catch (err) {
        console.error("❌ Error en bucle de descarga:", err);
        if (!res.writableEnded) res.end();
    }
}

// --- AUXILIARES (SIN CAMBIOS) ---
export async function uploadThumbnailBuffer(buffer) {
    await initClient();
    const res = await client.sendFile(botChatId, { file: buffer, forceDocument: false });
    return await getTelegramFileId(res.id, botChatId);
}

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) return null;
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const d = await res.json();
        if (d.ok) return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`;
    } catch (e) {} 
    return null;
}

async function getTelegramFileId(msgId, chId) {
    if(!BOT_TOKEN) return null;
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:chId.toString(), from_chat_id:chId.toString(), message_id:msgId}) });
        const d = await res.json();
        if(d.ok) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:chId.toString(), message_id:d.result.message_id}) });
            return d.result.document?.file_id || d.result.photo?.pop()?.file_id;
        }
    } catch(e){} return null;
}