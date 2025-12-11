import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from 'buffer';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = BigInt(process.env.TELEGRAM_CHANNEL_ID); 
const botChatId = BigInt(process.env.BOT_CHANNEL_ID || chatId);
const BOT_TOKEN = process.env.BOT_TOKEN; // Tu bot principal

// --- 1. GESTIÓN DE LA GRANJA DE BOTS (WORKERS) ---
// Leemos los tokens de los trabajadores desde el .env
const workerTokens = (process.env.WORKER_TOKENS || "").split(",");
const clients = [];
let isConnecting = false;

async function initClients() {
    if (clients.length > 0 || isConnecting) return;
    isConnecting = true;
    
    // Filtramos tokens vacíos
    const validTokens = workerTokens.filter(t => t && t.length > 10);

    if (validTokens.length === 0) {
        console.log("⚠️ No hay WORKER_TOKENS definidos. Usando solo el bot principal si es posible.");
    } else {
        console.log(`🚀 Iniciando Granja de Bots (${validTokens.length} trabajadores)...`);
    }

    const promises = validTokens.map(async (token, index) => {
        try {
            // Creamos cliente SIN sesión guardada (los bots no la necesitan tanto)
            const client = new TelegramClient(new StringSession(""), apiId, apiHash, { 
                connectionRetries: 5,
                useWSS: false 
            });
            
            // Login con Token de Bot
            await client.start({
                botAuthToken: token.trim(),
            });

            clients.push(client);
            console.log(`✅ Bot Trabajador ${index + 1} conectado.`);
        } catch (e) {
            console.error(`❌ Falló Bot Trabajador ${index + 1}:`, e.message);
        }
    });

    await Promise.all(promises);
    isConnecting = false;
}

// Elige un bot al azar para trabajar
async function getWorker() {
    await initClients();
    
    // Si no hay trabajadores extra, intentamos usar el cliente principal si existiera, 
    // o lanzamos error.
    if (clients.length === 0) throw new Error("No hay bots trabajadores disponibles. Revisa WORKER_TOKENS en el .env");
    
    return clients[Math.floor(Math.random() * clients.length)];
}

// --- 2. SUBIDA ---
export async function uploadFromStream(stream, fileName, fileSize) {
    const client = await getWorker(); // Usamos un bot cualquiera
    
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
    
    // Importante: El bot que subió el archivo lo envía al canal
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true, caption: fileName });

    return { 
        telegram_id: await getTelegramFileId(res.id, chatId), 
        message_id: res.id 
    };
}

// --- 3. STREAMING (REPRODUCCIÓN BALANCEADA) ---
export async function streamFile(messageId, res, range) {
    const client = await getWorker(); // Asignamos un bot aleatorio al usuario
    
    // IMPORTANTE: El bot debe ser ADMIN del canal para poder ver este mensaje
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Mensaje no encontrado (¿El bot es admin del canal?)");
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

    // Gestión de Rangos
    let start = 0;
    let end = fileSize - 1;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    }

    const chunksize = (end - start) + 1;

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

    await streamChunksToRes(client, location, res, start, end, fileSize);
}

// --- 4. ALGORITMO ESCALERA (OPTIMIZADO) ---
async function streamChunksToRes(client, location, res, requestedStart, requestedEnd, totalFileSize) {
    let currentOffset = BigInt(requestedStart - (requestedStart % 4096));
    const end = BigInt(requestedEnd);
    const totalSize = BigInt(totalFileSize);
    let initialSkip = requestedStart % 4096;
    const BASE_CHUNK = 64 * 1024; 

    try {
        while (currentOffset <= end) {
            const remainingInFile = totalSize - currentOffset;
            if (remainingInFile <= 0n) break;

            let limit = BASE_CHUNK;
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
        // Ignorar errores leves
    } finally {
        if (!res.writableEnded) res.end();
    }
}

// --- AUXILIARES ---
export async function uploadThumbnailBuffer(buffer) {
    const client = await getWorker(); 
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