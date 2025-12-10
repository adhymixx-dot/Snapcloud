import { TelegramClient, Api } from "telegram"; // <--- IMPORTANTE: Agrega Api
import { StringSession } from "telegram/sessions/index.js";
// ... (resto de tus imports y configs)

// ... (initClient y getTelegramFileId se quedan igual)

/**
 * 🌊 STREAMING UPLOAD: Sube un archivo directamente desde un flujo (stream) sin guardar en disco.
 * Ideal para archivos > 500MB en servidores con poca RAM/Disco (como Render).
 */
export async function uploadFromStream(stream, fileName, fileSize) {
    await initClient();
    console.log(`🌊 Iniciando streaming de: ${fileName} (${fileSize} bytes aprox)`);

    const fileId = BigInt(Date.now()); // ID temporal para la subida
    const partSize = 512 * 1024; // 512KB por chunk (Estándar de Telegram)
    const totalParts = Math.ceil(fileSize / partSize);

    let partIndex = 0;
    let buffer = Buffer.alloc(0);

    // Promesa para manejar el flujo
    await new Promise((resolve, reject) => {
        stream.on('data', async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);

            // Si acumulamos suficiente para un chunk, subimos
            if (buffer.length >= partSize) {
                stream.pause(); // Pausar lectura mientras subimos
                const chunkToSend = buffer.slice(0, partSize);
                buffer = buffer.slice(partSize);

                try {
                    await client.invoke(new Api.upload.SaveBigFilePart({
                        fileId: fileId,
                        filePart: partIndex,
                        fileTotalParts: totalParts,
                        bytes: chunkToSend
                    }));
                    console.log(`✅ Parte ${partIndex}/${totalParts} subida`);
                    partIndex++;
                    stream.resume(); // Continuar lectura
                } catch (err) {
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

        stream.on('error', reject);
    });

    console.log("📤 Finalizando subida, generando mensaje...");

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

    // Obtener ID compatible con Bot API (tu lógica existente)
    const finalFileId = await getTelegramFileId(messageResult.id, chatId);

    return {
        telegram_id: finalFileId,
        message_id: messageResult.id
    };
}