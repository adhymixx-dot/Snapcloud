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

// --- SUBIDA (Estándar) ---
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

// --- VISUALIZACIÓN ESTABLE (Sin Pipelining) ---
export async function streamFile(req, messageId, res, range) {
    await initClient();
    
    // 1. Obtener Info
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
    
    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Connection': 'keep-alive' // Ayuda a mantener la conexión abierta
    });

    await streamChunksToRes(req, location, res, start, end, fileSize);
}

// --- DESCARGA SEGURA (Secuencial) ---
async function streamChunksToRes(req, location, res, requestedStart, requestedEnd, totalFileSize) {
    let currentOffset = BigInt(requestedStart - (requestedStart % 4096));
    const end = BigInt(requestedEnd);
    let initialSkip = requestedStart % 4096;

    // Mantenemos 512KB porque es el equilibrio ideal
    const CHUNK_SIZE = 512 * 1024; 

    let isAborted = false;
    // Manejo robusto de cierre
    const onClose = () => { isAborted = true; };
    req.on("close", onClose);
    res.on("close", onClose);
    res.on("error", onClose);

    try {
        while (currentOffset <= end) {
            // Verificar ANTES de pedir a Telegram
            if (isAborted || res.writableEnded || res.closed) break;

            // Petición síncrona (esperamos a que llegue antes de seguir)
            // Esto evita el ERR_QUIC_PROTOCOL_ERROR por saturación
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: currentOffset,
                limit: CHUNK_SIZE
            }));

            if (!result || !result.bytes || result.bytes.length === 0) break;

            let chunk = result.bytes;

            // Cortar sobrante inicial
            if (initialSkip > 0) {
                chunk = chunk.slice(initialSkip);
                initialSkip = 0;
            }

            // Verificar DESPUÉS de recibir (por si el usuario canceló mientras descargábamos)
            if (isAborted || res.closed) break;

            // Escribir al cliente
            const canWrite = res.write(chunk);
            
            // Opcional: Si el buffer de Node está lleno, podríamos esperar (pero para video simple no suele hacer falta)
            
            currentOffset += BigInt(result.bytes.length);

            if (result.bytes.length < CHUNK_SIZE) break;
        }
    } catch (err) {
        if (!isAborted) console.error("⚠️ Stream Error:", err.message);
    } finally {
        req.removeListener("close", onClose); // Limpieza de listeners
        if (!res.writableEnded && !res.closed) res.end();
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