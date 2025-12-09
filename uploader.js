import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const botSession = new StringSession(process.env.TELEGRAM_SESSION); // tu bot
const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL); // canal del usuario
const botChannelId = BigInt(process.env.TELEGRAM_BOT_CHANNEL);   // canal del bot para miniaturas

const client = new TelegramClient(botSession, apiId, apiHash, { connectionRetries: 5 });
let started = false;

async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado");
}

/**
 * Subir archivo a Telegram
 * @param {*} file archivo { path, originalname }
 * @param {*} toUserChannel boolean - true: canal del usuario, false: canal del bot
 * @returns { id, url }
 */
export async function uploadToTelegram(file, toUserChannel = true) {
  try {
    await initTelegram();
    const chatId = toUserChannel ? userChannelId : botChannelId;

    const result = await client.sendFile(chatId, {
      file: file.path,
      caption: file.originalname || "SnapCloud upload"
    });

    // Telegram no devuelve URL directa para archivos grandes, pero para fotos/videos podemos usar:
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.id}`;

    // Borrar archivo temporal
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    return { id: result.id, url: fileUrl };
  } catch (err) {
    console.error("Error subiendo a Telegram:", err);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    throw err;
  }
}

/**
 * Crear miniatura (imagen o video)
 * @param {*} file archivo original { path, originalname }
 * @returns archivo temporal de miniatura
 */
export async function createThumbnail(file) {
  const isVideo = file.mimetype.startsWith("video");
  const thumbPath = file.path + "_thumb.jpg";

  if (!isVideo) {
    // Imagen
    await sharp(file.path).resize(300, 300).toFile(thumbPath);
  } else {
    // Video: primer frame
    await new Promise((resolve, reject) => {
      ffmpeg(file.path)
        .screenshots({
          count: 1,
          folder: file.path.substring(0, file.path.lastIndexOf("/")),
          filename: file.filename + "_thumb.jpg",
          size: "300x?"
        })
        .on("end", resolve)
        .on("error", reject);
    });
  }

  return { path: thumbPath, originalname: "thumb_" + file.originalname };
}
