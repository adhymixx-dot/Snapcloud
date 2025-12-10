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
// ID de canales
const chatId = getRequiredBigInt("TELEGRAM_CHANNEL_ID"); 
// const botChatId = getRequiredBigInt("BOT_CHANNEL_ID"); // Opcional si no usas miniaturas por ahora
const BOT_TOKEN = process.env.BOT_TOKEN;

// Cliente de Usuario (MTProto)
const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let clientStarted = false;
async function initClient() {
  if (clientStarted) return;
  await client.connect();
  clientStarted = true;
  console.log("Telegram CLIENTE (Usuario Único) conectado.");
}

/**
 * 🔑 Estrategia robusta: Obtener file_id usando la Bot API (forwardMessage).
 */
async function getTelegramFileId(messageId, channelIdBigInt) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");

    const channelIdStr = channelIdBigInt.toString(); 
    
    // 1. Reenviamos el mensaje al mismo canal usando el Bot
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/forwardMessage`;
    const params = {
        chat_id: channelIdStr,
        from_chat_id: channelIdStr,
        message_id: messageId
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await response.json();

        if (!data.ok) {
            throw new Error(`Error Bot API forwardMessage: ${data.description}`);
        }

        const forwardedMsg = data.result;
        
        // 2. Extraer el file_id del mensaje reenviado
        let fileId = null;
        if (forwardedMsg.document) {
            fileId = forwardedMsg.document.file_id;
        } else if (forwardedMsg.video) {
            fileId = forwardedMsg.video.file_id;
        } else if (forwardedMsg.photo) {
            // La foto es un array, tomamos la última (más grande)
            fileId = forwardedMsg.photo[forwardedMsg.photo.length - 1].file_id;
        }

        if (!fileId) throw new Error("No se encontró file_id en el mensaje reenviado.");

        // 3. Borrar el mensaje reenviado (limpieza)
        const deleteUrl = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
        await fetch(deleteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: channelIdStr,
                message_id: forwardedMsg.message_id
            })
        });

        return fileId;

    } catch (err) {
        console.error("Fallo al obtener file_id vía Bot API:", err);
        throw err;
    }
}

// --- FUNCIONES DE EXPORTACIÓN ---

/**
 * 🌊 STREAMING UPLOAD: Sube un archivo directamente desde un flujo (stream) sin guardar en disco.
 * Ideal para archivos > 500MB en servidores con poca RAM/Disco (como Render).
 */
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    console.log(`🌊 Iniciando streaming de: ${fileName} (${fileSize} bytes aprox)`);

    const fileId = BigInt(Date.now()); // ID temporal para la subida
    const partSize = 512 * 1024; // 512KB por chunk (Estándar de Telegram)
    
    // Calculamos partes totales (si fileSize es 0 o inválido, usamos -1 para indicar desconocido, 
    // pero GramJS prefiere saberlo. Si falla, intenta poner un número alto fijo).
    const totalParts = fileSize > 0 ? Math.ceil(fileSize / partSize) : -1;

    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    // Promesa para manejar el flujo
    await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Si acumulamos suficiente para un chunk, subimos
            if (buffer.length >= partSize) {
                stream.pause(); // Pausar lectura del stream mientras subimos
                const chunkToSend = buffer.slice(0, partSize);
                buffer = buffer.slice(partSize);

                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: fileId,
                        filePart: partIndex,
                        fileTotalParts: totalParts,
                        bytes: chunkToSend
                    }));
                    
                    // Log de progreso simple (opcional)
                    if (partIndex % 10 === 0) console.log(`✅ Parte ${partIndex} subida`);
                    
                    partIndex++;
                    stream.resume(); // Continuar lectura
                } catch (err) {
                    console.error("Error subiendo parte:", err);
                    reject(err);
                }
            }
        });

        stream.on('end', async () => {
            // Subir lo que sobre en el buffer (último pedazo)
            if (buffer.length > 0) {
                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: fileId,
                        filePart: partIndex,
                        fileTotalParts: totalParts,
                        bytes: buffer
                    }));
                    console.log(`✅ Parte final ${partIndex} subida`);
                } catch (err) {
                    reject(err);
                }
            }
            resolve();
        });

        stream.on('error', (err) => {
            console.error("Error en el stream de entrada:", err);
            reject(err);
        });
    });

    console.log("📤 Finalizando subida, generando mensaje en Telegram...");

    // Construir el archivo final en Telegram
    const inputFile = new Api.InputFileBig({
        id: fileId,
        parts: partIndex + 1,
        name: fileName
    });

    // Enviar el mensaje con el archivo al canal
    const messageResult = await client.sendFile(chatId, {
        file: inputFile,
        caption: "SnapCloud Stream Upload ☁️",
        forceDocument: true
    });

    // Obtener ID compatible con Bot API
    const finalFileId = await getTelegramFileId(messageResult.id, chatId);

    return {
        telegram_id: finalFileId,
        message_id: messageResult.id
    };
}

/**
 * 🔗 Obtiene la URL de descarga de la CDN de Telegram (USA LA API HTTP DEL BOT).
 * Funciona solo para archivos < 20MB (miniaturas/imágenes pequeñas).
 */
export async function getFileUrl(fileId) {
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN no configurado.");
    
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
        const responsePath = await fetch(url);
        const dataPath = await responsePath.json();
        
        if (!dataPath.ok) {
            // Manejo silencioso de errores comunes (ej: archivo demasiado grande para bot API)
            console.warn(`Advertencia getFile: ${dataPath.description}`);
            return null; 
        }

        const filePath = dataPath.result.file_path;
        return `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

    } catch (error) {
        console.error("Error en getFileUrl:", error.message);
        throw error;
    }
}

/**
 * 🎥 STREAMING DOWNLOAD: Descarga el archivo usando el Cliente de Usuario (sin límite de tamaño)
 * y lo escribe directamente en la respuesta del servidor (res).
 */
export async function streamFile(messageId, res) {
    await initClient();

    // 1. Obtenemos el mensaje original para acceder al medio
    const messages = await client.getMessages(chatId, { ids: [Number(messageId)] });
    const message = messages[0];

    if (!message || !message.media) {
        throw new Error("Mensaje o archivo no encontrado en Telegram");
    }

    const media = message.media.document || message.media.video || message.media.photo;
    
    // 2. Usamos iterDownload para bajarlo por pedazos y enviarlo al navegador
    // chunkSize aumentado a 512KB para mejor rendimiento en videos grandes
    const stream = client.iterDownload(media, {
        chunkSize: 512 * 1024, 
    });
    
    // Si el cliente cierra la conexión (cierra pestaña), terminamos el stream para no gastar recursos.
    res.on('close', () => {
         res.end(); 
    });

    for await (const chunk of stream) {
        // Escribimos cada pedazo en la respuesta HTTP
        res.write(chunk);
    }
    
    res.end();
}