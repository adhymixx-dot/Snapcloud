import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from 'buffer'; // Aseguramos Buffer

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

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) return null;
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
        const d = await res.json();
        if (d.ok) return `https://api.telegram.org/file/bot${BOT_TOKEN}/${d.result.file_path}`;
    } catch (e) {} 
    return null;
}

// --- VISUALIZACIÓN (SOLUCIÓN MANUAL DEFINITIVA) ---
export async function streamFile(messageId, res) {
    await initClient();
    console.log(`🔍 Buscando ID para stream: ${messageId}`);

    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs || !msgs[0]) throw new Error("Mensaje no encontrado");
    
    const msg = msgs[0];

    // AQUÍ ESTÁ EL TRUCO: Construimos la ubicación manualmente.
    // Esto evita que la librería intente "adivinar" y falle.
    let inputLocation = null;
    let dcId = null;

    try {
        if (msg.media) {
            if (msg.media.document) {
                // Es un VIDEO o DOCUMENTO
                console.log("📂 Procesando Documento...");
                const doc = msg.media.document;
                dcId = doc.dcId;
                
                inputLocation = new Api.InputDocumentFileLocation({
                    id: doc.id,
                    accessHash: doc.accessHash,
                    fileReference: doc.fileReference,
                    thumbSize: "" // Vacio = original
                });

            } else if (msg.media.photo) {
                // Es una FOTO
                console.log("📸 Procesando Foto...");
                const photo = msg.media.photo;
                dcId = photo.dcId;
                
                // Usamos la última versión (la más grande)
                const sizes = photo.sizes;
                const largest = sizes[sizes.length - 1];
                
                inputLocation = new Api.InputPhotoFileLocation({
                    id: photo.id,
                    accessHash: photo.accessHash,
                    fileReference: photo.fileReference,
                    thumbSize: largest.type
                });
            }
        }
    } catch (e) {
        console.error("Error construyendo ubicación:", e);
    }

    if (!inputLocation) {
        throw new Error("No se pudo determinar la ubicación del archivo.");
    }

    console.log("▶️ Iniciando transmisión...");

    try {
        // Pasamos la ubicación manual construida
        const stream = client.iterDownload(inputLocation, { 
            chunkSize: 64 * 1024,
            dcId: dcId,
            fileSize: msg.media.document ? msg.media.document.size : undefined
        });

        for await (const chunk of stream) {
            res.write(chunk);
        }
        res.end();
        console.log("✅ Stream completado.");
    } catch (err) {
        console.error("❌ Error en iterDownload:", err);
        throw err;
    }
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