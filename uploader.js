import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = Number(process.env.TELEGRAM_CHANNEL_ID); // tu canal privado

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

    const result = await client.sendFile(chatId, {
      file: file.buffer,               // Multer en memoria
      filename: file.originalname,     // nombre en Telegram
      caption: "SnapCloud upload"
    });

    console.log("Archivo subido:", result.id || result);
    return result;

  } catch (err) {
    console.error("Error subiendo a Telegram:", err);
    throw err;
  }
}
