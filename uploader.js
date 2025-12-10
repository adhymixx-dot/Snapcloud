import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

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

// --- SUBIDA (UPLOAD) - SIN CAMBIOS ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    const fileId = BigInt(Date.now());
    let partIndex = 0, buffer = Buffer.alloc(0); 
    const partSize = 512*1024;
    
    await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length >= partSize) {
                stream.pause();
                const chunkToSend = buffer.slice(0, partSize); 
                buffer = buffer.slice(partSize);
                try { 
                    await client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: partIndex, fileTotalParts: -1, bytes: chunkToSend })); 
                    partIndex++; 
                    stream.resume(); 
                } catch (e) { reject(e); }
            }
        });
        stream.on('end', async () => {
            if (buffer.length > 0) {
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: partIndex, fileTotalParts: -1, bytes: buffer }));
                } catch (e) { reject(e); }
            }
            resolve();
        });
    });

    const inputFile = new Api.InputFileBig({ id: fileId, parts: partIndex + 1, name: fileName });
    const res = await client.sendFile(chatId, { file: inputFile, forceDocument: true });
    return { telegram_id: await getTelegramFileId(res.id, chatId), message_id: res.id };
}

export async function uploadThumbnailBuffer(buffer) {
    await initClient();
    const res = await client.sendFile(botChatId, { file: buffer, forceDocument: false });
    return await getTelegramFileId(res.id, botChatId);
}

// --- VISUALIZACIÓN (STREAMING) ---
export async function streamFile(messageId, res) {
    await initClient();
    console.log(`🔍 Buscando ID: ${messageId}`);

    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || msgs.length === 0 || !msgs[0]) {
        throw new Error("Mensaje no encontrado.");
    }
    
    const msg = msgs[0];

    // --- SOLUCIÓN DEL ERROR "CANNOT CAST" ---
    // En lugar de construir la ubicación manualmente, extraemos el objeto Documento/Foto real.
    // GramJS sabe cómo descargar estos objetos nativos.
    let mediaToDownload = null;

    if (msg.media) {
        if (msg.media.document) {
            // Es un video o archivo. Extraemos el objeto 'Document' puro.
            console.log("📂 Detectado: Documento");
            mediaToDownload = msg.media.document;
        } else if (msg.media.photo) {
            // Es una foto. Extraemos el objeto 'Photo' puro.
            console.log("📸 Detectado: Foto");
            mediaToDownload = msg.media.photo;
        } else {
            // Fallback: intentamos usar el media wrapper si no es ninguno de los anteriores
            mediaToDownload = msg.media;
        }
    }

    if (!mediaToDownload) {
        throw new Error("El mensaje no tiene un archivo válido (mediaToDownload es null).");
    }

    console.log("▶️ Transmitiendo al visor...");

    try {
        const stream = client.iterDownload(mediaToDownload, { 
            chunkSize: 64 * 1024, 
            // Pasamos el dcId si está disponible para ayudar a la librería a encontrar el servidor
            dcId: mediaToDownload.dcId || null 
        });

        for await (const chunk of stream) {
            res.write(chunk);
        }
        res.end();
        console.log("✅ Stream finalizado.");
    } catch (err) {
        console.error("❌ Error interno iterDownload:", err);
        throw err;
    }
}

// --- UTILIDADES ---
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