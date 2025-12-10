const { Api } = require("telegram");
const { bigInt } = require("telegram/Helpers"); // A veces necesario para manejar IDs grandes

// -----------------------------------------------------------
// CONFIGURACIÓN: TAMAÑO DE BLOQUE (CHUNK)
// -----------------------------------------------------------
// Telegram exige múltiplos de 4096 bytes (4KB).
// Usamos 1MB (1024 * 1024) para un streaming fluido de video.
const TELEGRAM_CHUNK_SIZE = 1024 * 1024; 

// -----------------------------------------------------------
// RUTA DE STREAMING
// -----------------------------------------------------------
app.get('/media/:channelUsername/:messageId', async (req, res) => {
    try {
        const { channelUsername, messageId } = req.params;
        
        // 1. OBTENER EL MENSAJE PARA SACAR METADATOS
        // Necesitamos saber el tamaño total y el tipo de archivo antes de descargar nada.
        const messages = await client.getMessages(channelUsername, {
            ids: [parseInt(messageId)],
        });

        const msg = messages[0];

        if (!msg || !msg.media) {
            return res.status(404).send("Mensaje o archivo no encontrado");
        }

        // Detectar si es Documento (Video/Archivo) o Foto
        let fileSize, mimeType, fileLocation, fileName;

        if (msg.media.document) {
            // ES UN VIDEO O DOCUMENTO
            const doc = msg.media.document;
            fileSize = doc.size; // Tamaño total
            mimeType = doc.mimeType || 'application/octet-stream';
            
            // Crear la ubicación para la API
            fileLocation = new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize: "", // Vacío para el archivo real
            });
        } else if (msg.media.photo) {
            // ES UNA FOTO
            // Las fotos no suelen usarse con streaming parcial, pero lo manejamos
            // Usamos la variante más grande de la foto
            const photo = msg.media.photo;
            const sizeData = photo.sizes[photo.sizes.length - 1]; // La última suele ser la mejor calidad
            fileSize = sizeData.size; // A veces es desconocido en fotos, cuidado aquí
            mimeType = 'image/jpeg';
            
            fileLocation = new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference,
                thumbSize: sizeData.type,
            });
        } else {
            return res.status(400).send("Tipo de media no soportado");
        }
        
        // Convertir fileSize a número JS (a veces viene como BigInt)
        fileSize = Number(fileSize);

        // -----------------------------------------------------------
        // LÓGICA DE STREAMING (RANGE REQUESTS)
        // -----------------------------------------------------------
        const range = req.headers.range;

        if (range) {
            // >> CASO VIDEO: El navegador pide un trozo específico
            
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;

            // --- CORRECCIÓN MATEMÁTICA PARA TELEGRAM (LIMIT_INVALID FIX) ---
            
            // 1. Alinear el inicio al múltiplo de 4096 más cercano hacia abajo
            const telegramStart = start - (start % 4096);
            
            // 2. Pedir un bloque fijo grande (1MB) a Telegram
            // Nota: Si estamos cerca del final, Telegram cortará automáticamente, no te preocupes.
            const telegramLimit = TELEGRAM_CHUNK_SIZE;

            console.log(`🎥 Stream: Browser pide ${start}-${end}. Pidiendo a Telegram ${telegramStart} (Limit: ${telegramLimit})`);

            const result = await client.invoke(
                new Api.upload.GetFile({
                    location: fileLocation,
                    offset: telegramStart,
                    limit: telegramLimit,
                    precise: true,
                    cdnSupported: false,
                })
            );

            // 3. Procesar el Buffer recibido
            let buffer = result.bytes;

            // Recortar el inicio sobrante (porque pedimos desde el múltiplo de 4096 anterior)
            const offsetDifference = start - telegramStart;
            if (offsetDifference > 0) {
                buffer = buffer.slice(offsetDifference);
            }

            // Recortar el final si nos pasamos de lo que pidió el navegador
            // (El navegador a veces pide solo 20KB para headers de video)
            if (buffer.length > chunkSize) {
                buffer = buffer.slice(0, chunkSize);
            }

            // Enviar headers parciales (206)
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${start + buffer.length - 1}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': buffer.length,
                'Content-Type': mimeType,
            });
            res.end(buffer);

        } else {
            // >> CASO IMAGEN O DESCARGA COMPLETA: No hay Range Header
            // Telegram sigue exigiendo bloques de 4KB, pero aquí podemos iterar o descargar el primer chunk.
            // Para imágenes pequeñas, 512KB suele sobrar.
            
            console.log("🖼️ Descarga completa / Imagen");
            
            const result = await client.invoke(
                new Api.upload.GetFile({
                    location: fileLocation,
                    offset: 0,
                    limit: TELEGRAM_CHUNK_SIZE, // 1MB suficiente para casi todas las fotos
                    precise: true,
                    cdnSupported: false,
                })
            );

            res.writeHead(200, {
                'Content-Length': result.bytes.length,
                'Content-Type': mimeType,
            });
            res.end(result.bytes);
        }

    } catch (error) {
        console.error("❌ Error General en Ruta:", error);
        // Evitar crashear si los headers ya se enviaron
        if (!res.headersSent) {
            res.status(500).send("Error interno del servidor: " + error.message);
        }
    }
});