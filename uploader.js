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

// --- SUBIDA (ESTO FUNCIONA BIEN) ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    const fileId = BigInt(Date.now());
    const PART_SIZE = 512 * 1024;
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / PART_SIZE) : -1;

    console.log(`🌊 Subiendo: ${fileName}`);
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= PART_SIZE) {
            const chunkToSend = buffer.slice(0, PART_SIZE);
            buffer = buffer.slice(PART_SIZE);
            try {
                await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: fileId,
                    filePart: partIndex,
                    fileTotalParts: totalParts,
                    bytes: chunkToSend
                }));
                partIndex++;
            } catch (err) { throw err; }
        }
    }

    if (buffer.length > 0) {
        await client.invoke(new Api.upload.SaveBigFilePart({
            fileId: fileId,
            filePart: partIndex,
            fileTotalParts: totalParts,
            bytes: buffer
        }));
        partIndex++;
    }

    const inputFile = new Api.InputFileBig({ id: fileId, parts: partIndex, name: fileName });
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true, caption: fileName });

    return { 
        telegram_id: await getTelegramFileId(res.id, chatId), 
        message_id: res.id 
    };
}

// --- VISUALIZACIÓN (STREAMING CORREGIDO) ---
export async function streamFile(messageId, res, range) {
    await initClient();
    
    // 1. Info del archivo
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Mensaje no encontrado");
    const msg = msgs[0];

    let location = null;
    let fileSize = 0;
    let mimeType = "application/octet-stream";

    if (msg.media) {
        if (msg.media.document) {
            const doc = msg.media.document;
            fileSize = Number(doc.size);
            mimeType = doc.mimeType;
            location = new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize: ""
            });
        } else if (msg.media.photo) {
            const photo = msg.media.photo;
            const size = photo.sizes[photo.sizes.length - 1];
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

    if (!location) throw new Error("Sin archivo válido");

    // 2. Gestionar Rangos
    let start = 0;
    let end = fileSize - 1;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    const chunksize = (end - start) + 1;
    console.log(`🎬 Stream: ${start}-${end} (Total: ${fileSize})`);

    // Headers
    if (range) {
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': mimeType,
        });
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
        });
    }

    // 3. Iniciar descarga inteligente
    // Pasamos el fileSize total para no pasarnos del límite
    await streamChunksToRes(location, res, start, end, fileSize);
}

// --- FUNCIÓN CLAVE CORREGIDA ---
async function streamChunksToRes(location, res, startByte, endByte, totalFileSize) {
    let offset = BigInt(startByte);
    const end = BigInt(endByte);
    const totalSize = BigInt(totalFileSize);

    // Configuración de bloques
    const MAX_CHUNK = 1024 * 1024; // 1MB (Bloque grande ideal)
    const BLOCK_4KB = 4096;        // Mínima unidad de Telegram

    try {
        while (offset <= end) {
            // 1. Calculamos cuánto nos falta para llegar al final de lo solicitado
            // Ojo: No podemos pedir más allá del final REAL del archivo.
            
            // Cuánto espacio real queda en el archivo desde donde estamos:
            const remainingInFile = totalSize - offset;
            
            // Si por alguna razón estamos fuera, salimos
            if (remainingInFile <= 0n) break;

            // Decidimos cuánto pedir. Por defecto 1MB.
            let bytesToRequest = MAX_CHUNK;

            // Si lo que queda en el archivo es MENOS de 1MB, ajustamos.
            if (remainingInFile < BigInt(MAX_CHUNK)) {
                // Truco matemático: Redondear hacia ARRIBA al múltiplo de 4096 más cercano
                // Ejemplo: Faltan 100 bytes. Pedimos 4096.
                // Ejemplo: Faltan 4100 bytes. Pedimos 8192.
                const remainder = Number(remainingInFile);
                bytesToRequest = Math.ceil(remainder / BLOCK_4KB) * BLOCK_4KB;
            }

            // Llamada a la API
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: offset,
                limit: bytesToRequest // Ahora esto siempre es "seguro"
            }));

            if (!result || result.bytes.length === 0) break;

            // Solo enviamos al navegador la parte útil (si Telegram manda padding)
            // Aunque normalmente Telegram manda justo lo que queda si es el final.
            res.write(result.bytes);
            
            offset += BigInt(result.bytes.length);

            // Si el cliente cierra conexión, abortar
            if (res.writableEnded || res.closed) break;
            
            // Si recibimos menos de un bloque completo, es que se acabó
            if (result.bytes.length < bytesToRequest) break;
        }
    } catch (err) {
        console.error("❌ Error en Stream:", err);
    } finally {
        if (!res.writableEnded) res.end();
    }
}

// --- AUXILIARES ---
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