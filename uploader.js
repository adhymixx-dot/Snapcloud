import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredEnv(varName) {
    const value = process.env[varName];
    if (!value) throw new Error(`CRITICAL ERROR: Faltante ${varName}`);
    return value;
}

// Configuración
const apiId = Number(getRequiredEnv("TELEGRAM_API_ID"));
const apiHash = getRequiredEnv("TELEGRAM_API_HASH");
const sessionString = getRequiredEnv("TELEGRAM_SESSION");
const chatId = BigInt(getRequiredEnv("TELEGRAM_CHANNEL_ID")); 
const botChatId = BigInt(process.env.BOT_CHANNEL_ID || chatId); 
const BOT_TOKEN = process.env.BOT_TOKEN;

// Cliente
const session = new StringSession(sessionString);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientPromise = null;

async function initClient() {
    if (!clientPromise) {
        console.log("🔌 Conectando a Telegram...");
        clientPromise = client.connect();
    }
    await clientPromise;
}

// --- SUBIDA (UPLOAD) ---
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    console.log(`🌊 Subiendo stream: ${fileName}`);
    const fileId = BigInt(Date.now());
    const partSize = 512 * 1024; 
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / partSize) : -1;
    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length >= partSize) {
                stream.pause();
                const chunkToSend = buffer.slice(0, partSize);
                buffer = buffer.slice(partSize);
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: chunkToSend
                    }));
                    partIndex++;
                    stream.resume();
                } catch (err) { reject(err); }
            }
        });
        stream.on('end', async () => {
            if (buffer.length > 0) {
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId, filePart: partIndex, fileTotalParts: totalParts, bytes: buffer
                    }));
                } catch (err) { reject(err); }
            }
            resolve();
        });
        stream.on('error', reject);
    });

    const inputFile = new Api.InputFileBig({ id: fileId, parts: partIndex + 1, name: fileName });
    const messageResult = await client.sendFile(chatId, { file: inputFile, caption: "SnapCloud File", forceDocument: true });
    
    const finalFileId = await getTelegramFileId(messageResult.id, chatId);
    return { telegram_id: finalFileId, message_id: messageResult.id };
}

export async function uploadThumbnailBuffer(buffer) {
    await initClient();
    const messageResult = await client.sendFile(botChatId, {
        file: buffer,
        caption: "thumb",
        forceDocument: false 
    });
    return await getTelegramFileId(messageResult.id, botChatId);
}

// --- AUXILIARES ---
async function getTelegramFileId(messageId, channelIdBigInt) {
    if (!BOT_TOKEN) return "no_bot_token";
    const channelIdStr = channelIdBigInt.toString(); 
    
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelIdStr, from_chat_id: channelIdStr, message_id: messageId })
        });
        const data = await res.json();
        if (!data.ok) return null;

        const fwd = data.result;
        let fid = null;
        if (fwd.document) fid = fwd.document.file_id;
        else if (fwd.photo) fid = fwd.photo[fwd.photo.length - 1].file_id;
        
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelIdStr, message_id: fwd.message_id })
        });
        return fid;
    } catch (e) { return null; }
}

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) return null;
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) return null;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
    } catch (e) { return null; }
}

// --- STREAMING (FIX DEFINITIVO) ---
export async function streamFile(messageId, res) {
    await initClient();
    
    console.log(`🔍 Buscando mensaje ID: ${messageId}`);

    // 1. Obtener mensaje
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    
    if (!msgs || msgs.length === 0 || !msgs[0]) {
        throw new Error("Mensaje no encontrado (puede haber sido borrado).");
    }
    
    const msg = msgs[0];

    // 2. Extraer el objeto EXACTO que GramJS necesita (Documento o Foto)
    // Esto evita el error "Cannot cast [object Object]"
    let mediaObject = null;

    if (msg.media) {
        if (msg.media.document) {
            console.log("📂 Tipo: Documento/Video");
            mediaObject = msg.media.document;
        } else if (msg.media.photo) {
            console.log("📸 Tipo: Foto");
            mediaObject = msg.media.photo;
        } else {
            // Caso raro: a veces el media es directo si no tiene wrapper
            mediaObject = msg.media;
        }
    }

    if (!mediaObject) {
        console.log("Dump msg:", msg);
        throw new Error("No se encontró archivo adjunto válido en el mensaje.");
    }

    console.log(`⬇️ Iniciando descarga...`);

    try {
        // 3. Descargar usando el objeto extraído
        const stream = client.iterDownload(mediaObject, { 
            chunkSize: 64 * 1024, // 64KB
        });
        
        res.on('close', () => {
            console.log("Cliente cerró conexión.");
            res.end();
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