import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from 'buffer';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN; 

// --- 🔧 AUTOCORRECTOR DE IDs (BLINDADO) ---
function fixId(id) {
    if (!id) return BigInt(0);
    let s = String(id).trim();
    // Si ya empieza por -100, es válido
    if (s.startsWith("-100")) return BigInt(s);
    // Si empieza por - (ej: -123), le quitamos el - y ponemos -100
    if (s.startsWith("-")) return BigInt("-100" + s.substring(1));
    // Si son solo números, le ponemos -100
    return BigInt("-100" + s);
}

// Aplicamos la corrección
const chatId = fixId(process.env.TELEGRAM_CHANNEL_ID); 
const botChatId = process.env.BOT_CHANNEL_ID ? fixId(process.env.BOT_CHANNEL_ID) : chatId;

// --- GESTIÓN DE BOTS (WORKERS) ---
const workerTokens = (process.env.WORKER_TOKENS || "").split(",");
const clients = [];
let isConnecting = false;

async function initClients() {
    if (clients.length > 0 || isConnecting) return;
    isConnecting = true;
    const validTokens = workerTokens.filter(t => t && t.length > 10);

    if (validTokens.length === 0) console.log("ℹ️ No WORKER_TOKENS. Usando fallback.");
    else console.log(`🚀 Iniciando Granja (${validTokens.length} bots)...`);

    await Promise.all(validTokens.map(async (token, idx) => {
        try {
            const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5, useWSS: false });
            await client.start({ botAuthToken: token.trim() });
            
            // --- TRUCO CRÍTICO: "SALUDAR" AL CANAL ---
            // Esto obliga al bot a obtener el 'Access Hash' del canal.
            // Sin esto, la subida falla con "Could not find input entity".
            try {
                await client.invoke(new Api.channels.GetChannels({
                    id: [new Api.InputChannel({ channelId: bigIntToId(chatId), accessHash: BigInt(0) })] 
                    // Nota: Enviamos accessHash 0 para forzar la búsqueda si falla lo normal, 
                    // o simplemente intentamos obtener info básica.
                }));
            } catch (e) {
                // Si falla lo anterior, intentamos un getEntity normal, que suele resolverlo
                try { await client.getEntity(chatId); } catch(err) {}
            }

            clients.push(client);
            console.log(`✅ Bot ${idx+1} conectado y sincronizado.`);
        } catch (e) { console.error(`❌ Error Worker ${idx+1}:`, e.message); }
    }));
    isConnecting = false;
}

// Función auxiliar para quitar el -100 si es necesario para ciertas llamadas internas
function bigIntToId(id) {
    let s = String(id);
    if (s.startsWith("-100")) return BigInt(s.substring(4));
    return id;
}

async function getWorker() {
    await initClients();
    if (clients.length === 0) throw new Error("No hay workers disponibles. Revisa WORKER_TOKENS");
    return clients[Math.floor(Math.random() * clients.length)];
}

// --- UPLOAD ---
export async function uploadFromStream(stream, fileName, fileSize) {
    const client = await getWorker();
    const fileId = BigInt(Date.now());
    
    // TAMAÑO 128KB: El más compatible y seguro
    const PART_SIZE = 128 * 1024;
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / PART_SIZE) : -1;

    console.log(`🌊 Subiendo: ${fileName}`);
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= PART_SIZE) {
            const chunkToSend = buffer.slice(0, PART_SIZE);
            buffer = buffer.slice(PART_SIZE);
            await client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: chunkToSend }));
            partIndex++;
        }
    }
    if (buffer.length > 0) {
        await client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: buffer }));
        partIndex++;
    }

    const inputFile = new Api.InputFileBig({ id: fileId, parts: partIndex, name: fileName });
    // Usamos el ID corregido
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true, caption: fileName });
    
    return { telegram_id: await getTelegramFileId(res.id, chatId), message_id: res.id };
}

// --- STREAMING (ESTABILIDAD TOTAL) ---
export async function streamFile(messageId, res, range) {
    const client = await getWorker();
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs[0]) throw new Error("Mensaje no encontrado");
    const msg = msgs[0];
    let location = null, fileSize = 0, mime = "application/octet-stream";

    if (msg.media?.document) {
        fileSize = Number(msg.media.document.size); mime = msg.media.document.mimeType;
        location = new Api.InputDocumentFileLocation({ id: msg.media.document.id, accessHash: msg.media.document.accessHash, fileReference: msg.media.document.fileReference, thumbSize: "" });
    } else if (msg.media?.photo) {
        const p = msg.media.photo; const s = p.sizes[p.sizes.length-1]; fileSize = s.size; mime = "image/jpeg";
        location = new Api.InputPhotoFileLocation({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference, thumbSize: s.type });
    }

    if (!location) throw new Error("No media");
    
    let start = 0, end = fileSize - 1;
    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    const chunk = (end - start) + 1;
    res.writeHead(range ? 206 : 200, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes', 'Content-Length': chunk, 'Content-Type': mime
    });

    await streamChunksToRes(client, location, res, start, end, fileSize);
}

async function streamChunksToRes(client, location, res, requestedStart, requestedEnd, totalFileSize) {
    let currentOffset = BigInt(requestedStart - (requestedStart % 4096));
    const end = BigInt(requestedEnd);
    const totalSize = BigInt(totalFileSize);
    let initialSkip = requestedStart % 4096;
    
    // TAMAÑO BASE 128KB (Estándar de Oro para evitar LIMIT_INVALID)
    const BASE_CHUNK = 128 * 1024; 

    try {
        while (currentOffset <= end) {
            const remaining = totalSize - currentOffset;
            if (remaining <= 0n) break;
            
            let limit = BASE_CHUNK;
            // Algoritmo Escalera (Precisión para el final del archivo)
            if (remaining < BigInt(BASE_CHUNK)) {
                if (remaining <= 4096n) limit = 4096;
                else if (remaining <= 16384n) limit = 16384; 
                else if (remaining <= 32768n) limit = 32768;
                else if (remaining <= 65536n) limit = 65536;
                else limit = 131072; // 128KB
            }

            const result = await client.invoke(new Api.upload.GetFile({ location, offset: currentOffset, limit }));
            if (!result || !result.bytes.length) break;

            let chunk = result.bytes;
            if (initialSkip > 0) { chunk = chunk.slice(initialSkip); initialSkip = 0; }

            if (!res.writableEnded && !res.closed) res.write(chunk); else break;
            currentOffset += BigInt(result.bytes.length);
            if (result.bytes.length < limit) break;
        }
    } catch (err) { 
        // Solo logueamos si es un error grave, ignoramos desconexiones de usuario
        if(!err.message.includes("LIMIT_INVALID")) console.warn("Stream Warn:", err.message); 
    } 
    finally { if (!res.writableEnded) res.end(); }
}

export async function uploadThumbnailBuffer(buffer) {
    // Si falla la miniatura, no detenemos la subida principal
    try {
        const client = await getWorker();
        const res = await client.sendFile(botChatId, { file: buffer, forceDocument: false });
        return await getTelegramFileId(res.id, botChatId);
    } catch (e) {
        console.error("❌ Error Miniatura:", e.message);
        return null; 
    }
}

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) return null;
    try { const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`); const d = await r.json(); if(d.ok) return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`; } catch (e) {} return null;
}

// Esta función usa el BOT_TOKEN (El Jefe).
async function getTelegramFileId(msgId, chId) {
    if(!BOT_TOKEN) return null;
    const strChId = String(chId); 
    try { const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:strChId, from_chat_id:strChId, message_id:msgId}) }); const d = await r.json(); if(d.ok) { await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_id:strChId, message_id:d.result.message_id}) }); return d.result.document?.file_id || d.result.photo?.pop()?.file_id; } else { console.error("❌ Error ID:", d.description); } } catch(e){} return null;
}