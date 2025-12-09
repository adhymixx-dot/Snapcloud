import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs-extra";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = new StringSession(process.env.TELEGRAM_SESSION);
const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL); // Donde suben los archivos originales
const botChannelId = BigInt(process.env.TELEGRAM_BOT_CHANNEL);   // Canal para miniaturas
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;
async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado.");
}

// Subir archivo y generar miniatura
export async function uploadFile(file) {
  await initTelegram();

  // Subir archivo original al canal de usuarios
  const result = await client.sendFile(userChannelId, { file: file.path });
  console.log("Archivo subido:", result.id);

  // Crear miniatura
  let thumbPath;
  if (file.mimetype.startsWith("image")) {
    // Redimensionar imagen
    thumbPath = file.path + "_thumb.jpg";
    await sharp(file.path).resize(200, 200, { fit: 'cover' }).toFile(thumbPath);
  } else if (file.mimetype.startsWith("video")) {
    // Tomar un frame del video
    thumbPath = file.path + "_thumb.jpg";
    await new Promise((resolve, reject) => {
      ffmpeg(file.path)
        .screenshots({
          count: 1,
          folder: "./",
          filename: thumbPath.split("/").pop(),
          size: '200x?'
        })
        .on('end', resolve)
        .on('error', reject);
    });
  }

  // Subir miniatura al canal del bot
  const thumbResult = await client.sendFile(botChannelId, { file: thumbPath });
  console.log("Miniatura subida:", thumbResult.id);

  // Limpiar archivos locales
  fs.unlinkSync(file.path);
  fs.unlinkSync(thumbPath);

  return {
    fileId: result.id,
    thumbId: thumbResult.id,
    type: file.mimetype.startsWith("video") ? "video" : "image",
    name: file.originalname
  };
}
