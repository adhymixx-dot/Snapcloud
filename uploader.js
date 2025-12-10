import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { CustomFile } from "telegram/client/uploads.js";
import input from "input"; // npm install input

// --- CONFIGURACIÓN ---
const API_ID = parseInt(process.env.TELEGRAM_API_ID || "TU_API_ID");
const API_HASH = process.env.TELEGRAM_API_HASH || "TU_API_HASH";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "TU_BOT_TOKEN";
const SESSION_STRING = process.env.TELEGRAM_SESSION || ""; 

// ID del canal donde guardas los archivos (debe ser negativo si es un canal/grupo)
// Ejemplo: -100123456789
const LOG_CHANNEL_ID = BigInt(process.env.LOG_CHANNEL_ID || "-1000000000000");

// Inicializar cliente
const stringSession = new StringSession(SESSION_STRING);
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
});

// Conectar al iniciar
(async () => {
    console.log("🔄 Conectando a Telegram...");
    await client.start({
        botAuthToken: BOT_TOKEN,
    });
    console.log("✅ Telegram CLIENTE conectado.");
    // Guardar sesión si no existe
    if (!SESSION_STRING) {
        console.log("⚠️ GUARDA ESTA SESSION STRING EN RENDER:", client.session.save());
    }
})();

// --- FUNCIONES ---

export async function uploadFromStream(fileStream, fileName, fileSize) {
    // Convertimos el stream de busboy a un CustomFile que GramJS entienda
    const toUpload = new CustomFile(fileName, fileSize, "", fileStream);

    try {
        const result = await client.sendFile(LOG_CHANNEL_ID, {
            file: toUpload,
            forceDocument: false, // Deja que Telegram decida si es video o archivo
            workers: 1, // Subida secuencial para estabilidad
        });

        console.log("✅ Archivo subido a Telegram. ID:", result.id);
        return {
            message_id: result.id,
            telegram_id: result.id // Redundancia útil
        };
    } catch (error) {
        console.error("❌ Error subiendo a Telegram:", error);
        throw error;
    }
}

export async function uploadThumbnailBuffer(buffer) {
    try {
        // Subimos la miniatura como una foto normal
        const result = await client.sendFile(LOG_CHANNEL_ID, {
            file: buffer,
            forceDocument: false
        });
        return result.id; // Retornamos el ID del mensaje de la foto
    } catch (error) {
        console.error("❌ Error subiendo thumbnail:", error);
        return null;
    }
}

export async function getFileUrl(messageId) {
    // Esta función genera un link temporal (no la usamos para el stream directo, pero útil tenerla)
    return null; 
}

// --- FUNCIÓN CORREGIDA PARA EL STREAM ---
export async function streamFile(messageId, res) {
    try {
        // 1. IMPORTANTE: Buscar el mensaje completo primero
        // No podemos descargar solo con el ID numérico, necesitamos el objeto Message
        const messages = await client.getMessages(LOG_CHANNEL_ID, { ids: [messageId] });
        const message = messages[0];

        if (!message || !message.media) {
            console.error("❌ Mensaje no encontrado o sin media en Telegram");
            if (!res.headersSent) res.status(404).end();
            return;
        }

        // 2. Determinar tamaño para el header (opcional pero bueno para barra de progreso)
        const size = message.media.document ? message.media.document.size : 0;
        if (size > 0) res.setHeader("Content-Length", size);

        // 3. Iniciar descarga por pedazos (Streaming)
        // Usamos 'iterDownload' pasando el MENSAJE, no el ID.
        for await (const chunk of client.iterDownload(message, {
            requestSize: 1024 * 1024, // Chunks de 1MB
        })) {
            // Escribir el pedazo en la respuesta al navegador
            const canContinue = res.write(chunk);
            
            // Si el navegador se llena, esperamos a que se vacíe (Backpressure)
            if (!canContinue) {
                await new Promise(resolve => res.once('drain', resolve));
            }
        }

        res.end(); // Terminar transmisión

    } catch (error) {
        console.error("❌ Error CRÍTICO en stream:", error);
        if (!res.headersSent) res.status(500).end();
    }
}