import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import sharp from "sharp"; // Para miniaturas de imágenes
import ffmpeg from "fluent-ffmpeg";
import path from "path";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const botChannelId = BigInt(process.env.TELEGRAM_BOT_CHANNEL); // Canal donde el bot guarda miniaturas
const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL); // Canal donde se suben archivos originales

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;
async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado.");
}

/**
 * Genera miniatura de imagen o video
 * @param {string} filePath
 * @param {string} type "image" | "video"
 * @returns {Promise<string>} ruta del archivo miniatura
 */
function generateThumbnail(filePath, type) {
  return new Promise((resolve, reject) => {
    const thumbPath = filePath + "_thumb.jpg";
    if (type === "image") {
      sharp(filePath)
        .resize(200, 200, { fit: "cover" })
        .toFile(thumbPath)
        .then(() => resolve(thumbPath))
        .catch(reject);
    } else if (type === "video") {
      ffmpeg(filePath)
        .screenshots({
          count: 1,
          folder: path.dirname(filePath),
          filename: path.basename(thumbPath),
          size: "200x200"
        })
        .on("end", () => resolve(thumbPath))
        .on("error", reject);
    } else reject(new Error("Tipo desconocido para miniatura"));
  });
}

/**
 * Sube archivo y miniatura a Telegram
 * @param {object} file multer file
 */
export async function uploadFile(file) {
  await initTelegram();
  const type = file.mimetype.startsWith("video") ? "video" : "image";

  // Generar miniatura local
  const thumbPath = await generateThumbnail(file.path, type);

  // Subir archivo original al canal del usuario
  const resultOriginal = await client.sendFile(userChannelId, {
    file: file.path,
    caption: "Archivo SnapCloud"
  });

  // Subir miniatura al canal del bot
  const resultThumb = await client.sendFile(botChannelId, {
    file: thumbPath,
    caption: "Miniatura"
  });

  // Limpiar archivos locales
  fs.unlinkSync(file.path);
  fs.unlinkSync(thumbPath);

  return {
    name: file.originalname,
    fileId: resultOriginal.id, // Para descargar/reproducir
    thumbId: resultThumb.id,   // Para mostrar en galería
    type
  };
}
