import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs/promises"; // Usar la versión de promesas para operaciones asíncronas
import fsSync from "fs"; // Usar sync version para path check en el fallback

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = Number(process.env.TELEGRAM_CHANNEL_ID);

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;

async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado al canal privado.");
}

export async function uploadToTelegram(file) {
  try {
    await initTelegram();

    // Enviar archivo usando la ruta temporal
    console.log(`Subiendo archivo ${file.originalname} desde ${file.path}...`);
    const result = await client.sendFile(chatId, {
      file: file.path,
      caption: `SnapCloud upload: ${file.originalname}`
    });

    console.log("Archivo subido:", result.id || result);

    // Borrar archivo temporal después de subir (de forma asíncrona)
    await fs.unlink(file.path);
    console.log(`Archivo temporal ${file.path} borrado.`);

    return result;

  } catch (err) {
    console.error("Error subiendo a Telegram:", err);

    // Borrar archivo temporal si falla
    if (fsSync.existsSync(file.path)) {
      try {
         await fs.unlink(file.path);
         console.log(`Archivo temporal ${file.path} borrado tras el error.`);
      } catch (cleanupErr) {
         console.error("Error al intentar borrar el archivo temporal:", cleanupErr);
      }
    }

    // Re-lanzar el error para que el servidor.js lo maneje
    throw new Error(`Fallo al subir archivo a Telegram: ${err.message}`);
  }
}