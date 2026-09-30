import { describe, expect, it } from "vitest";
import {
  connectTelegramDb,
  disconnectTelegramDb,
  isTelegramDbRequest,
  parseTelegramCredentials,
  readTelegramDbConfig,
} from "../src/lib/telegramDb";

const TOKEN = "7123456789:AAHk3xQvZ9pL2mN8rT5wY1bC4dE6fG7hJ0k";

describe("base de datos en Telegram", () => {
  it("reconoce la petición y extrae token y chat", () => {
    const msg = `Oye, conecta este proyecto con la base de datos de Telegram. Token ${TOKEN} y el ID del chat es -1001234567890`;
    expect(isTelegramDbRequest(msg)).toBe(true);
    expect(parseTelegramCredentials(msg)).toEqual({ token: TOKEN, chatId: "-1001234567890" });
    expect(parseTelegramCredentials(`conecta telegram ${TOKEN} 987654321`)).toEqual({ token: TOKEN, chatId: "987654321" });
    expect(isTelegramDbRequest("pon el botón en verde")).toBe(false);
  });

  it("conecta todas las páginas y se puede desconectar", () => {
    const files = {
      "index.html": "<html><body><form><input name=email></form></body></html>",
      "contacto/index.html": "<html><body><form></form></body></html>",
      "styles.css": "body{}",
    };
    const updated = connectTelegramDb(files, { token: TOKEN, chatId: "123456789" }, "Mi web");
    expect(updated["telegram-db.js"]).toContain(TOKEN);
    expect(updated["index.html"]).toContain('<script src="telegram-db.js"></script>');
    expect(updated["contacto/index.html"]).toContain('<script src="../telegram-db.js"></script>');
    const merged = { ...files, ...updated };
    expect(readTelegramDbConfig(merged)).toEqual({ token: TOKEN, chatId: "123456789" });
    const { updated: cleaned, deleted } = disconnectTelegramDb(merged);
    expect(deleted).toEqual(["telegram-db.js"]);
    expect(cleaned["index.html"]).not.toContain("telegram-db.js");
    expect(cleaned["contacto/index.html"]).not.toContain("telegram-db.js");
  });

  it("el script generado es JavaScript válido", () => {
    const { "telegram-db.js": js } = connectTelegramDb({ "index.html": "<body></body>" }, { token: TOKEN, chatId: "1" }, 'Nombre "raro"');
    expect(() => new Function(js)).not.toThrow();
  });
});
