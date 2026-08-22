export const AGENT_REPLY_MAX = 2000;

export function sanitizeAgentReply(text: string) {
  let out = String(text ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (out.length > AGENT_REPLY_MAX) out = `${out.slice(0, AGENT_REPLY_MAX - 1)}…`;
  return out;
}
