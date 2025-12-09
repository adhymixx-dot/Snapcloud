import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = BigInt(process.env.TELEGRAM_CHANNEL_ID); // usar BigInt

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
    const result = await client.sendFile(chatId, { file: file.path, caption: "SnapCloud upload" });
    console.log("Archivo subido:", result.id || result);
    fs.unlinkSync(file.path);
    return result;
  } catch (err) {
    console.error("Error subiendo a Telegram:", err);
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    throw err;
  }
}
