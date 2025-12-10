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

// --- SUBIDA BLINDADA (SOLUCIÓN AL ERROR DE PART_SIZE) ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    const fileId = BigInt(Date.now());
    const PART_SIZE = 512 * 1024; // 512KB (Regla estricta de Telegram)
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / PART_SIZE) : -1;

    console.log(`🌊 Subiendo: ${fileName} (${fileSize} bytes) | Partes estimadas: ${totalParts}`);
    
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    // USAMOS 'FOR AWAIT' PARA EVITAR CONDICIONES DE CARRERA
    // Esto garantiza que procesamos los datos en orden perfecto.
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
        
        // Mientras tengamos suficiente para un bloque de 512KB, subimos
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
            } catch (err) {
                console.error(`❌ Error subiendo parte ${partIndex}:`, err);
                throw err; // Detener si falla
            }
        }
    }

    // Subir el remanente final (si queda algo)
    if (buffer.length > 0) {
        await client.invoke(new Api.upload.SaveBigFilePart({
            fileId: fileId,
            filePart: partIndex,
            fileTotalParts: totalParts,
            bytes: buffer
        }));
        partIndex++;
    }

    console.log(`✅ Subida de partes finalizada (${partIndex} partes). Generando archivo...`);

    // Finalizar y crear el archivo en el chat
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

// --- VISUALIZACIÓN MANUAL (SIN CAMBIOS, YA FUNCIONABA) ---
export async function streamFile(messageId, res) {
    await initClient();
    console.log(`🔍 Stream ID: ${messageId}`);

    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Mensaje no encontrado");
    const msg = msgs[0];

    let location = null;
    let fileSize = 0;
    let mimeType = "application/octet-stream";

    // Extracción manual segura
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

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", fileSize);
    
    console.log(`▶️ Descargando bytes directos (${fileSize})...`);

    const CHUNK_SIZE = 512 * 1024; // Pedimos bloques de 512KB
    let offset = BigInt(0);
    
    try {
        while (true) {
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: offset,
                limit: CHUNK_SIZE
            }));

            if (!result || result.bytes.length === 0) break;

            res.write(result.bytes);
            offset = offset + BigInt(result.bytes.length);

            if (result.bytes.length < CHUNK_SIZE) break;
        }
        res.end();
        console.log("✅ Stream OK");
    } catch (err) {
        console.error("❌ Error Stream:", err);
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