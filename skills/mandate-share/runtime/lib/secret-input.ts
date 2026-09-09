import { MAX_PASSWORD_BYTES } from "./access-core.ts";

/** Read a password without accepting it as command-line text or echoing it. */
export async function readSecret(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4096) throw new Error("Secret input is too long.");
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!text || /[\r\n\0]/.test(text)) throw new Error("Supply one non-empty password line.");
    if (Buffer.byteLength(text) > MAX_PASSWORD_BYTES) throw new Error("Secret input is too long.");
    return text;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("No terminal for hidden input. Use --password-stdin with a protected input source.");
  process.stderr.write("Password: ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write("\n");
      if (error) reject(error); else if (!value) reject(new Error("Password cannot be empty.")); else resolve(value);
    };
    const onData = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Password entry cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else if (character >= " ") value += character;
        if (Buffer.byteLength(value) > MAX_PASSWORD_BYTES) return finish(new Error("Secret input is too long."));
      }
    };
    process.stdin.on("data", onData);
  });
}
