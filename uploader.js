// --- 4. ALGORITMO ESCALERA (MODO TURBO 512KB) ---
async function streamChunksToRes(client, location, res, requestedStart, requestedEnd, totalFileSize) {
    let currentOffset = BigInt(requestedStart - (requestedStart % 4096));
    const end = BigInt(requestedEnd);
    const totalSize = BigInt(totalFileSize);
    let initialSkip = requestedStart % 4096;

    // ANTES: 64 * 1024; (Muy lento)
    // AHORA: 512 * 1024; (8 veces más rápido y fluido)
    const BASE_CHUNK = 512 * 1024; 

    try {
        while (currentOffset <= end) {
            const remainingInFile = totalSize - currentOffset;
            if (remainingInFile <= 0n) break;

            // Por defecto pedimos un bloque grande (512KB)
            let limit = BASE_CHUNK;

            // Si estamos al final del archivo y queda MENOS de 512KB, 
            // usamos la escalera para evitar el error LIMIT_INVALID
            if (remainingInFile < BigInt(BASE_CHUNK)) {
                if (remainingInFile <= 4096n) limit = 4096;
                else if (remainingInFile <= 8192n) limit = 8192;
                else if (remainingInFile <= 16384n) limit = 16384;
                else if (remainingInFile <= 32768n) limit = 32768;
                else if (remainingInFile <= 65536n) limit = 65536;
                else if (remainingInFile <= 131072n) limit = 131072;
                else limit = 262144; // 256KB
            }

            // Descarga desde Telegram
            const result = await client.invoke(new Api.upload.GetFile({
                location: location,
                offset: currentOffset,
                limit: limit
            }));

            if (!result || result.bytes.length === 0) break;

            let chunk = result.bytes;
            
            // Recorte inicial si fue necesario alinear
            if (initialSkip > 0) {
                chunk = chunk.slice(initialSkip);
                initialSkip = 0;
            }

            // Enviar al navegador
            // Verificamos que la respuesta siga abierta antes de escribir
            if (!res.writableEnded && !res.closed) {
                res.write(chunk);
            } else {
                break; 
            }

            currentOffset += BigInt(result.bytes.length);

            // Si Telegram devolvió menos de lo pedido, se acabó el archivo
            if (result.bytes.length < limit) break;
        }
    } catch (err) {
        // El error QUIC suele pasar aquí cuando el usuario cierra el video
        // Solo lo logueamos como advertencia, no como error crítico
        console.warn("⚠️ Stream interrumpido (Usuario cerró o saltó):", err.message);
    } finally {
        if (!res.writableEnded) res.end();
    }
}