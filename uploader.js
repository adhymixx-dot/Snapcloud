import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import path from "path";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const userChannelId = BigInt(process.env.TELEGRAM_USER_CHANNEL);
const botChannelId = BigInt(process.env.TELEGRAM_BOT_CHANNEL);

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;

async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram conectado.");
}

export async function uploadFile(file) {
  await initTelegram();

  // ---- Subir archivo original al canal del usuario ----
  const fileResult = await client.sendFile(userChannelId, {
    file: file.path,
    caption: "SnapCloud upload",
    filename: file.originalname // <- CORRECCIÓN IMPORTANTE
  });

  // ---- Generar miniatura ----
  let thumbPath;
  let type;

  if (file.mimetype.startsWith("image")) {
    thumbPath = file.path + "_thumb.jpg";
    await sharp(file.path)
      .resize(200)
      .toFile(thumbPath);
    type = "image";
  } else if (file.mimetype.startsWith("video")) {
    thumbPath = path.join(path.dirname(file.path), path.parse(file.originalname).name + "_thumb.jpg");
    await new Promise((resolve, reject) => {
      ffmpeg(file.path)
        .screenshots({
          timestamps: ["50%"],
          filename: path.basename(thumbPath),
          folder: path.dirname(thumbPath),
          size: "200x?"
        })
        .on("end", resolve)
        .on("error", reject);
    });
    type = "video";
  }

  // ---- Subir miniatura al canal del bot ----
  const thumbResult = await client.sendFile(botChannelId, {
    file: thumbPath,
    filename: path.basename(thumbPath)
  });

  // ---- Limpiar archivos temporales ----
  fs.unlinkSync(file.path);
  if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

  // ---- Retornar datos para frontend ----
  return {
    name: file.originalname,
    fileId: fileResult.id || fileResult,
    thumbId: thumbResult.id || thumbResult,
    type
  };
}
