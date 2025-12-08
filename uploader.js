import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "fs";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION; // tu string session
const channelId = Number(process.env.TELEGRAM_CHANNEL_ID);

const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
  connectionRetries: 5
});

let started = false;
async function initClient() {
  if (started) return;
  await client.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN });
  started = true;
  console.log("Telegram conectado al canal privado.");
}

// Subir archivo
export async function uploadToTelegram(file) {
  await initClient();
  return await client.sendFile(channelId, {
    file: file.path,
    caption: file.originalname
  });
}

// Descargar archivo
export async function downloadFromTelegram(fileId) {
  await initClient();
  const buffer = await client.downloadFile(fileId); // GramJS permite descargar a buffer
  return buffer;
}
