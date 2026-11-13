// 关系插件的配对与消息加密。
//
// 两个人只要输入同一个配对码，就能算出同一个频道名和同一把密钥：
//   - 频道名 = maltese-rel-<sha256(配对码) 前 24 位>，宿主只看到这个名字；
//   - 消息体用 sha256 派生的密钥流异或后再 base64，中继服务器拿不到明文。
// 密钥只存在于两台机器上，配对码换了就等于换了一把新钥匙。

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 配对码 -> 中继频道名。 */
export async function topicForCode(code: string): Promise<string> {
  const digest = await sha256(encoder.encode(`maltese-relationship:${code.trim().toUpperCase()}`));
  return `maltese-rel-${toHex(digest).slice(0, 24)}`;
}

async function keyForCode(code: string): Promise<Uint8Array> {
  return sha256(encoder.encode(`maltese-relationship-key:${code.trim().toUpperCase()}`));
}

async function keystream(key: Uint8Array, iv: Uint8Array, length: number): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let produced = 0;
  let counter = 0;
  while (produced < length) {
    const block = await sha256(concatBytes(key, iv, encoder.encode(`#${counter}`)));
    blocks.push(block);
    produced += block.length;
    counter += 1;
  }
  return concatBytes(...blocks).slice(0, length);
}

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    out[index] = left[index] ^ right[index % right.length];
  }
  return out;
}

/** 把一条结构化消息加密成可以直接丢给中继的字符串。 */
export async function encryptMessage(code: string, payload: unknown): Promise<string> {
  const key = await keyForCode(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(payload));
  const stream = await keystream(key, iv, plain.length);
  return JSON.stringify({ v: 1, iv: toBase64(iv), data: toBase64(xorBytes(plain, stream)) });
}

/** 解不开（不是同一配对码 / 不是这个插件发的）就返回 null。 */
export async function decryptMessage(code: string, body: string): Promise<unknown | null> {
  try {
    const envelope = JSON.parse(body) as { v?: number; iv?: string; data?: string };
    if (!envelope.iv || !envelope.data) return null;
    const key = await keyForCode(code);
    const iv = fromBase64(envelope.iv);
    const cipher = fromBase64(envelope.data);
    const stream = await keystream(key, iv, cipher.length);
    const plain = decoder.decode(xorBytes(cipher, stream));
    return JSON.parse(plain) as unknown;
  } catch {
    return null;
  }
}

/** 生成一个新的配对码：6 位，去掉容易看错的 0/O/1/I。 */
export function generatePairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}
