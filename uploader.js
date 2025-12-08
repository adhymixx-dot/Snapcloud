import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl";
import fs from "fs";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const chatId = process.env.TELEGRAM_STORAGE_CHAT_ID;

const session = new StringSession(""); // vacío la primera vez
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 5,
});

let clientStarted = false;

export async function initTelegram() {
  if (clientStarted) return;
  clientStarted = true;

  console.log("Iniciando sesión en Telegram...");

  await client.start({
    phoneNumber: async () => process.env.TELEGRAM_PHONE,
    phoneCode: async () => {
      console.log("Escribe el código que Telegram te envió:");
      return await new Promise((resolve) => {
        process.stdin.once("data", (d) => resolve(d.toString().trim()));
      });
    },
    password: async () => process.env.TELEGRAM_2FA_PASSWORD
  });

  console.log("Sesión iniciada.");
}

export async function uploadToTelegram(file) {
  await initTelegram();

  const result = await client.sendFile(chatId, {
    file: file.path,
    caption: "SnapCloud upload"
  });

  fs.unlinkSync(file.path);

  return result;
}
