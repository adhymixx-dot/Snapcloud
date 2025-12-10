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

// --- SUBIDA (UPLOAD) ---
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

// --- FUNCIÓN QUE FALTABA (SOLUCIÓN AL ERROR) ---
export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) return null;
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const d = await res.json();
        if (d.ok) return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`;
    } catch (e) {} 
    return null;
}

// --- VISUALIZACIÓN (STREAMING BLINDADO) ---
export async function streamFile(messageId, res) {
    await initClient();
    console.log(`🔍 Buscando ID: ${messageId}`);

    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs[0]) throw new Error("Mensaje borrado o no encontrado");
    const msg = msgs[0];

    // CONSTRUCCIÓN MANUAL DE LA UBICACIÓN DEL ARCHIVO
    let location = null;
    
    if (msg.media) {
        if (msg.media.document) {
            const d = msg.media.document;
            location = new Api.InputDocumentFileLocation({ id: d.id, accessHash: d.accessHash, fileReference: d.fileReference, thumbSize: "" });
        } else if (msg.media.photo) {
            const p = msg.media.photo;
            // Buscamos el tamaño más grande disponible
            const sz = p.sizes[p.sizes.length-1].type;
            location = new Api.InputPhotoFileLocation({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference, thumbSize: sz });
        }
    }

    if (!location) throw new Error("No hay archivo válido en el mensaje");

    console.log("▶️ Transmitiendo al visor...");
    const stream = client.iterDownload(location, { chunkSize: 64*1024, dcId: msg.media.document?.dcId });

    for await (const chunk of stream) res.write(chunk);
    res.end();
}

// Helper interno
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