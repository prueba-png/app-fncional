import { useStudio } from "../store/studio";
import { connectTelegramDb, isTelegramDbRequest, isValidChatId, isValidToken, parseTelegramCredentials } from "./telegramDb";

/**
 * Atiende peticiones escritas como «conecta este proyecto con la base de datos de Telegram,
 * token 123:ABC… chat 456». Si trae token y chat válidos, conecta directamente; si no, abre la
 * ventana con lo que se haya podido leer. Devuelve true si el mensaje era una de estas peticiones.
 */
export async function handleTelegramDbCommand(text: string): Promise<boolean> {
  if (!isTelegramDbRequest(text)) return false;
  const studio = useStudio.getState();
  const { token, chatId } = parseTelegramCredentials(text);
  if (studio.project && token && chatId && isValidToken(token) && isValidChatId(chatId)) {
    const updated = connectTelegramDb(studio.project.files, { token, chatId }, studio.project.name);
    await studio.applyChanges(updated, [], "Conectado a la base de datos de Telegram", "dependency");
    studio.toast("Proyecto conectado: los formularios enviarán sus datos a tu Telegram", "success");
    return true;
  }
  studio.openTelegramDb({ token, chatId });
  return true;
}
