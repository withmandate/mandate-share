import { derivePasswordProof } from "../lib/access-core.ts";

/** Simulate the native-browser submission using only public prompt parameters. */
export async function unlockBody(html: string, password: string): Promise<URLSearchParams> {
  const challenge = /name="challenge" value="([^"]+)"/u.exec(html)?.[1];
  const parameters = /^2\.(\d+)\.([A-Za-z0-9_-]+)$/u.exec(challenge ?? "");
  if (!parameters) throw new Error("Missing browser password challenge.");
  const proof = await derivePasswordProof(password, { iterations: Number(parameters[1]), salt: parameters[2]! });
  return new URLSearchParams({ proof, challenge: challenge! });
}
