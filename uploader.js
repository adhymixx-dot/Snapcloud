import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = process.env.TELEGRAM_STORAGE_CHAT_ID;

// ⚠️ ESTA ES TU SESIÓN PERMANENTE (la pegarás luego)
const session = new StringSession(process.env.TELEGRAM_SESSION);

const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

let started = false;

// Inicializar sin interacción
export async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram listo.");
}

// Subir archivo
export async function uploadToTelegram(file) {
  await initTelegram();

  const buffer = file.buffer; // Multer puede trabajar en memoria

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
