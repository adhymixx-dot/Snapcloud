import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Configuración desde variables de entorno
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

// ⚠️ Chat ID del canal privado (negativo)
const chatId = Number(process.env.TELEGRAM_CHANNEL_ID);

const session = new StringSession(process.env.TELEGRAM_SESSION);
const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

let started = false;

// Inicialización de Telegram
export async function initTelegram() {
  if (started) return;
  await client.connect();
  started = true;
  console.log("Telegram listo.");
}

// Subir archivo al canal privado
export async function uploadToTelegram(file) {
  try {
    await initTelegram();

    const buffer = file.buffer;

    const result = await client.sendFile(chatId, {
      file: { _: "inputFile", data: buffer, name: file.originalname },
      caption: "SnapCloud upload"
    });

    console.log("Archivo subido a Telegram:", result.id || result);
    return result;

  } catch (err) {
    console.error("Error subiendo a Telegram:", err);

    // Error detallado para frontend
    if (err.message.includes("PEER_FLOOD") || err.message.includes("CHAT_WRITE_FORBIDDEN")) {
      throw new Error("No tienes permisos para subir al canal");
    }
    throw err;
  }
}
