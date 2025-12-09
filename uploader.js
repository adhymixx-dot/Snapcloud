import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import sharp from "sharp";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL); // Canal de los archivos originales
const botChannelId  = BigInt(process.env.TELEGRAM_BOT_CHANNEL);  // Canal del bot para miniaturas

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;
async function initTelegram() {
  if(started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado.");
}

export async function uploadToTelegram(file) {
  await initTelegram();

  // 1️⃣ Subir archivo original
  const originalResult = await client.sendFile(userChannelId, { file: file.path });
  console.log("Archivo original subido:", originalResult.id);

  // 2️⃣ Crear miniatura si es imagen
  let thumbId = null;
  if(file.mimetype.startsWith("image/")) {
    const thumbPath = file.path + "_thumb.jpg";
    await sharp(file.path).resize(200, 200, { fit: 'cover' }).toFile(thumbPath);

    const thumbResult = await client.sendFile(botChannelId, { file: thumbPath, caption: "Miniatura" });
    thumbId = thumbResult.id;
    fs.unlinkSync(thumbPath);
    console.log("Miniatura subida:", thumbId);
  }

  // Borrar archivo local
  if(fs.existsSync(file.path)) fs.unlinkSync(file.path);

  return { originalId: originalResult.id, thumbId };
}
