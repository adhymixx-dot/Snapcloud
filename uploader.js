import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Configuración desde variables de entorno
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// Para prueba: subir a tu chat personal
const chatId = "me"; // ⚠️ cambiar luego al canal privado

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;

// Inicialización de Telegram
export async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram listo (modo prueba en chat personal).");
}

// Subir archivo a chat personal
export async function uploadToTelegram(file) {
  try {
    await initTelegram();

    const buffer = file.buffer;

    const result = await client.sendFile(chatId, {
      file: { _: "inputFile", data: buffer, name: file.originalname },
      caption: "SnapCloud upload (prueba)"
    });

    console.log("Archivo subido a Telegram:", result.id || result);
    return result;

  } catch (err) {
    console.error("Error subiendo a Telegram:", err);
    throw err; // Esto hace que el backend devuelva 500 si falla
  }
}
