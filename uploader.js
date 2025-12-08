import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = process.env.TELEGRAM_STORAGE_CHAT_ID;

// Sesión pre-generada en variable de entorno
const session = new StringSession(process.env.TELEGRAM_SESSION);

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

let started = false;

export async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram listo.");
}

export async function uploadToTelegram(file) {
  await initTelegram();

  const buffer = file.buffer; // Multer lo guarda en memoria

  const result = await client.sendFile(chatId, {
    file: {
      _: "inputFile",
      data: buffer,
      name: file.originalname
    },
    caption: "SnapCloud upload"
  });

  return result;
}
