import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from 'buffer';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
// CAMBIO 1: Usamos tu Bot Token directamente
const BOT_TOKEN = process.env.BOT_TOKEN; 

// CAMBIO 2: Función para arreglar IDs (Evita CHANNEL_INVALID)
function fixId(id) {
    if (!id) return BigInt(0);
    let s = String(id).trim();
    if (s.startsWith("-100")) return BigInt(s);
    if (s.startsWith("-")) return BigInt("-100" + s.substring(1));
    return BigInt("-100" + s);
}

const chatId = fixId(process.env.TELEGRAM_CHANNEL_ID); 
const botChatId = process.env.BOT_CHANNEL_ID ? fixId(process.env.BOT_CHANNEL_ID) : chatId;

// Usamos un solo cliente (Tu lógica original)
const client = new TelegramClient(new StringSession(""), apiId, apiHash, { 
    connectionRetries: 5,
    useWSS: false 
});
let clientPromise = null;

async function initClient() {
    if (!clientPromise) { 
        console.log("🔌 Telegram conectando..."); 
        
        // CAMBIO 3: Conexión correcta para Bots
        clientPromise = (async () => {
            await client.start({ botAuthToken: BOT_TOKEN });
            
            // CAMBIO 4: Sincronización para evitar "Input Entity Not Found"
            try {
                await client.getDialogs({ limit: 10 });
                console.log("✅ Bot conectado y sincronizado.");
            } catch (e) { console.log("⚠️ Alerta sincro:", e.message); }
        })();
    }
    await clientPromise;
}

// --- SUBIDA (Tu código original) ---
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
    // Usamos el ID corregido (chatId)
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true, caption: fileName });

    return { 
        telegram_id: await getTelegramFileId(res.id, chatId), 
        message_id: res.id 
    };
}

// --- STREAMING (Tu código original) ---
export async function streamFile(messageId, res, range) {
    await initClient();
    
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

    let start = 0;
    let end = fileSize - 1;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    const chunksize = (end - start) + 1;

    res.writeHead(range ? 206 : 200, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
    });

    await streamChunksToRes(location, res, start, end, fileSize);
}

// --- TU LÓGICA DE 64KB (ESTABILIDAD PURA) ---
async function streamChunksToRes(location, res, requestedStart, requestedEnd, totalFileSize) {
    let currentOffset = BigInt(requestedStart - (requestedStart % 4096));
    const end = BigInt(requestedEnd);
    const totalSize = BigInt(totalFileSize);
    let initialSkip = requestedStart % 4096;

    // ESTO ES LO QUE HACE QUE FUNCIONE FLUIDO: 64KB
    const BASE_CHUNK = 64 * 1024; 

    try {
        while (currentOffset <= end) {
            const remainingInFile = totalSize - currentOffset;
            if (remainingInFile <= 0n) break;

            let limit = BASE_CHUNK;
            // Escalera para el final
            if (remainingInFile < BigInt(BASE_CHUNK)) {
                if (remainingInFile <= 4096n) limit = 4096;
                else if (remainingInFile <= 8192n) limit = 8192;
                else if (remainingInFile <= 16384n) limit = 16384;
                else if (remainingInFile <= 32768n) limit = 32768;
                else limit = 65536; 
            }

            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: currentOffset,
                limit: limit
            }));

            if (!result || result.bytes.length === 0) break;

            let chunk = result.bytes;
            if (initialSkip > 0) {
                chunk = chunk.slice(initialSkip);
                initialSkip = 0; 
            }

            res.write(chunk);
            currentOffset += BigInt(result.bytes.length);

            if (res.writableEnded || res.closed) break;
            if (result.bytes.length < limit) break;
        }
    } catch (err) {
        // Ignoramos errores silenciosos
        if(!err.message.includes("LIMIT_INVALID")) console.error("Stream:", err.message);
    } finally {
        if (!res.writableEnded) res.end();
    }
}

export async function uploadThumbnailBuffer(buffer) {
    await initClient();
    try {
        const res = await client.sendFile(botChatId, { file: buffer, forceDocument: false });
        return await getTelegramFileId(res.id, botChatId);
    } catch(e) { return null; }
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
    const strChId = String(chId); 
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:strChId, from_chat_id:strChId, message_id:msgId}) });
        const d = await res.json();
        if(d.ok) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:strChId, message_id:d.result.message_id}) });
            return d.result.document?.file_id || d.result.photo?.pop()?.file_id;
        }
    } catch(e){} return null;
}