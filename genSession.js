import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input"; // npm install input si no lo tienes

// Reemplaza con tu API ID y Hash de Telegram
const apiId = Number("30250546");
const apiHash = "090521087b55d7c6f243e86200b8b5a9";

// Session vacía al inicio
const stringSession = new StringSession("");

(async () => {
    console.log("Generando StringSession...");
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber: async () => await input.text("Número de teléfono (con código país, ej: +52xxxx): "),
        phoneCode: async () => await input.text("Código que recibiste por Telegram: "),
        password: async () => await input.text("Contraseña de 2FA (si tienes): "),
        onError: (err) => console.log(err),
    });

    console.log("✅ Sesión iniciada correctamente!");
    console.log("StringSession para Render:");
    console.log(client.session.save()); // Copia esto y úsalo en Render

    process.exit(0);
})();
