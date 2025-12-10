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

// --- SUBIDA (SIN CAMBIOS) ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    const fileId = BigInt(Date.now());
    const PART_SIZE = 512 * 1024;
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / PART_SIZE) : -1;
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= PART_SIZE) {
            const chunkToSend = buffer.slice(0, PART_SIZE);
            buffer = buffer.slice(PART_SIZE);
            try {
                await client.invoke(new Api.upload.SaveBigFilePart({
                    fileId: fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: chunkToSend
                }));
                partIndex++;
            } catch (err) { console.error(err); throw err; }
        }
    }
    if (buffer.length > 0) {
        await client.invoke(new Api.upload.SaveBigFilePart({
            fileId: fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: buffer
        }));
        partIndex++;
    }

    const inputFile = new Api.InputFileBig({ id: fileId, parts: partIndex, name: fileName });
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true, caption: fileName });

    let realSize = 0;
    if(res.media && res.media.document) realSize = res.media.document.size;

    return { 
        telegram_id: await getTelegramFileId(res.id, chatId), 
        message_id: res.id,
        file_size: realSize 
    };
}

// --- VISUALIZACIÓN POR RANGOS (CORREGIDO LIMIT_INVALID) ---
export async function streamFile(messageId, res, startByte = 0, endByte = -1) {
    await initClient();
    
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Msg no encontrado");
    const msg = msgs[0];

    let location = null;
    let fileSize = 0;

    if (msg.media) {
        if (msg.media.document) {
            const d = msg.media.document;
            fileSize = d.size;
            location = new Api.InputDocumentFileLocation({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: "" });
        } else if (msg.media.photo) {
            const p = msg.media.photo;
            const sz = p.sizes[p.sizes.length - 1];
            fileSize = sz.size;
            location = new Api.InputPhotoFileLocation({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference, thumbSize: sz.type });
        }
    }

    if (!location) throw new Error("Sin archivo");

    if (endByte === -1 || endByte >= fileSize) endByte = fileSize - 1;
    
    let currentOffset = BigInt(startByte);
    const end = BigInt(endByte);
    const CHUNK_SIZE = 1024 * 1024; // 1MB estándar

    try {
        while (currentOffset <= end) {
            // 1. Calculamos cuánto necesitamos realmente
            let needed = Number(end - currentOffset + 1n);
            if (needed > CHUNK_SIZE) needed = CHUNK_SIZE;

            // 2. CORRECCIÓN CRÍTICA: Ajustar a múltiplo de 4KB (4096)
            // Telegram exige que 'limit' sea divisible por 4096.
            let requestLimit = needed;
            if (requestLimit % 4096 !== 0) {
                // Redondeamos hacia arriba al múltiplo de 4096 más cercano
                requestLimit = Math.ceil(needed / 4096) * 4096;
            }

            // 3. Pedimos a Telegram (con el limit corregido)
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: currentOffset,
                limit: requestLimit 
            }));

            if (!result || result.bytes.length === 0) break;

            // 4. Si pedimos más de lo necesario por el redondeo, cortamos el sobrante
            // para no enviar basura al navegador.
            let bytesToSend = result.bytes;
            if (bytesToSend.length > needed) {
                bytesToSend = bytesToSend.slice(0, needed);
            }

            res.write(bytesToSend);
            
            currentOffset += BigInt(bytesToSend.length);
            
            // Si Telegram devolvió menos de lo que pedimos, es el fin del archivo
            if (result.bytes.length < requestLimit) break; 
        }
        
        res.end();
    } catch (err) {
        console.error("❌ Error Range Stream:", err);
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