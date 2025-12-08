import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// Canal privado
const chatId = Number(process.env.TELEGRAM_CHANNEL_ID); // -1003305031924

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

    // Enviar archivo
    const result = await client.sendFile(chatId, {
      file: { _: "inputFile", data: file.buffer, name: file.originalname },
      caption: "SnapCloud upload"
    });

    console.log("Archivo subido:", result.id || result);
    return result;

  } catch (err) {
    console.error("Error subiendo a Telegram:", err);
    throw err; // Esto hace que el backend devuelva 500 si falla
  }
}
