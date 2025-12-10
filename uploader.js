import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredBigInt(varName) {
    const value = process.env[varName];
    if (!value) {
        throw new Error(`CRITICAL ERROR: Environment variable ${varName} is missing or empty.`);
    }
    return BigInt(value);
}

// --- CONFIGURACIÓN ---
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); // <--- Asegúrate de tener esto en tu .env
const BOT_TOKEN = process.env.BOT_TOKEN;

// Cliente de Usuario (MTProto)
const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientStarted = false;
async function initClient() {
  if (clientStarted) return;
  await client.connect();
  clientStarted = true;
  console.log("Telegram CLIENTE conectado.");
}

async function getTelegramFileId(messageId, channelIdBigInt) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");
    const channelIdStr = channelIdBigInt.toString(); 
    
    // 1. Reenviar mensaje
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`;
    const params = { chat_id: channelIdStr, from_chat_id: channelIdStr, message_id: messageId };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();
        if (!data.ok) throw new Error(`Error Bot API: ${data.description}`);

        const forwardedMsg = data.result;
        let fileId = null;
        if (forwardedMsg.document) fileId = forwardedMsg.document.file_id;
        else if (forwardedMsg.video) fileId = forwardedMsg.video.file_id;
        else if (forwardedMsg.photo) fileId = forwardedMsg.photo[forwardedMsg.photo.length - 1].file_id;

        if (!fileId) throw new Error("No file_id found.");

        // 2. Borrar mensaje
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: channelIdStr, message_id: forwardedMsg.message_id })
        });

        return fileId;
    } catch (err) {
        console.error("Fallo obteniendo file_id:", err);
        throw err;
    }
}

// --- EXPORTACIONES ---

export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    console.log(`🌊 Streaming: ${fileName}`);
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
    const messageResult = await client.sendFile(chatId, { file: inputFile, caption: "SnapCloud Video", forceDocument: true });
    const finalFileId = await getTelegramFileId(messageResult.id, chatId);

    return { telegram_id: finalFileId, message_id: messageResult.id };
}

/**
 * 🖼️ NUEVO: Sube una miniatura desde un Buffer (Memoria)
 */
export async function uploadThumbnailBuffer(buffer) {
    await initClient();
    // Subimos la imagen directamente desde el buffer
    const messageResult = await client.sendFile(botChatId, {
        file: buffer,
        caption: "thumb",
        forceDocument: false // Enviar como foto
    });
    
    // Obtenemos el ID compatible
    const fileId = await getTelegramFileId(messageResult.id, botChatId);
    return fileId; // Retornamos solo el ID de la foto
}

export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN faltante.");
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) return null;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`;
    } catch (e) { return null; }
}

export async function streamFile(messageId, res) {
    await initClient();
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    if (!msgs[0] || !msgs[0].media) throw new Error("No media.");
    const stream = client.iterDownload(msgs[0].media, { chunkSize: 512 * 1024 });
    res.on('close', () => res.end());
    for await (const chunk of stream) res.write(chunk);
    res.end();
}