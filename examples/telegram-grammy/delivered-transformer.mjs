// A grammY API transformer that records every message the Bot API really accepted as
// "delivered". Failed calls never count, and a message that is sent once and then edited
// (streaming) stays one entry, keyed by its message_id.
//
//   bot.api.config.use(deliveredTransformer(owed));

const SEND_METHODS = new Set([
  'sendMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendVoice', 'sendAnimation',
]);
const EDIT_METHODS = new Set(['editMessageText', 'editMessageCaption']);

/** One conversation per chat, and per forum topic inside a chat. */
export const conversationIdOf = (chatId, threadId) =>
  threadId == null ? String(chatId) : `${chatId}:${threadId}`;

/**
 * @param {{ noteDelivered(conversationId: string, text: string, opts?: {id?: string|number}): unknown }} owed
 */
export function deliveredTransformer(owed) {
  return async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    try {
      if (!res?.ok || payload?.chat_id == null) return res;
      const cid = conversationIdOf(payload.chat_id, payload.message_thread_id);
      const text = payload.text ?? payload.caption ?? '';
      if (SEND_METHODS.has(method)) {
        const id = res.result?.message_id;
        owed.noteDelivered(cid, text || `[${method.slice(4).toLowerCase()}]`, { id: id != null ? `${cid}/${id}` : undefined });
      } else if (EDIT_METHODS.has(method) && payload.message_id != null && text) {
        owed.noteDelivered(cid, text, { id: `${cid}/${payload.message_id}` });
      }
    } catch {
      // logging must never break a send
    }
    return res;
  };
}
