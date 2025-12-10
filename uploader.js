import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// --- VALIDACIÓN DE VARIABLES ---
function getRequiredEnv(varName) {
    const value = process.env[varName];
    if (!value) throw new Error(`CRITICAL ERROR: Faltante ${varName}`);
    return value;
}

const apiId = Number(getRequiredEnv("TELEGRAM_API_ID"));
const apiHash = getRequiredEnv("TELEGRAM_API_HASH");
const sessionString = getRequiredEnv("TELEGRAM_SESSION");
// Aseguramos que el ID del canal se lea correctamente como BigInt (incluso si es negativo)
const chatId = BigInt(getRequiredEnv("TELEGRAM_CHANNEL_ID")); 
const botChatId = BigInt(process.env.BOT_CHANNEL_ID || chatId); 
const BOT_TOKEN = process.env.BOT_TOKEN;

const session = new StringSession(sessionString);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientPromise = null;

async function initClient() {
    if (!clientPromise) {
        console.log("🔌 Conectando a Telegram...");
        clientPromise = client.connect();
    }
    await clientPromise;
    // Verificación rápida de que estamos logueados
    if(!await client.checkAuthorization()) {
        throw new Error("❌ LA SESIÓN DE TELEGRAM HA EXPIRADO. Genera una nueva.");
    }
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
    
    // Obtenemos el ID compatible
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

// --- STREAMING (AQUÍ ESTABA EL ERROR) ---
export async function streamFile(messageId, res) {
    await initClient();
    
    console.log(`🔍 Buscando mensaje ID: ${messageId} en canal: ${chatId}`);

    // Obtenemos el mensaje
    const msgs = await client.getMessages(chatId, { ids: [Number(messageId)] });
    
    if (!msgs || msgs.length === 0 || !msgs[0]) {
        throw new Error("Mensaje no encontrado en Telegram (puede haber sido borrado).");
    }
    
    const msg = msgs[0];

    // Verificamos si es un mensaje vacío (pasa a veces si no hay acceso)
    if (!msg.media && !msg.document && !msg.photo) {
        console.log("Dump del mensaje:", msg); // Para ver en logs qué llegó
        throw new Error("El mensaje existe pero no tiene media o no es accesible.");
    }

    // CORRECCIÓN: Pasamos 'msg' (el objeto entero), NO 'msg.media'
    // Esto permite a GramJS saber de qué chat descargar el archivo.
    const stream = client.iterDownload(msg, { 
        chunkSize: 64 * 1024, // Ajustado para ser más estable
    });
    
    res.on('close', () => {
        console.log("Cliente cerró conexión, deteniendo stream.");
        res.end();
    });

    for await (const chunk of stream) {
        res.write(chunk);
    }
    res.end();
}