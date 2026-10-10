// wxapkg tool: decrypt PC-WeChat V1MMWX package + unpack wxapkg archive
// usage: node wxapkg.mjs decrypt <appid> <in.wxapkg> <out.wxapkg>
//        node wxapkg.mjs unpack  <in.wxapkg> <outdir>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAGIC = Buffer.from('V1MMWX');

function decrypt(appid, data) {
  if (!data.subarray(0, 6).equals(MAGIC)) return { data, decrypted: false };
  const key = crypto.pbkdf2Sync(Buffer.from(appid, 'utf8'), Buffer.from('saltiest'), 1000, 32, 'sha1');
  const iv = Buffer.from('the iv: 16 bytes');
  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
  dec.setAutoPadding(false);
  // AES block covers plaintext[0..1022]; its 1024th plaintext byte is padding garbage.
  const head = Buffer.concat([dec.update(data.subarray(6, 1030)), dec.final()]).subarray(0, 1023);
  const xk = appid.length >= 2 ? appid.charCodeAt(appid.length - 2) : 0x66;
  const tail = Buffer.from(data.subarray(1030));
  for (let i = 0; i < tail.length; i++) tail[i] ^= xk;
  return { data: Buffer.concat([head, tail]), decrypted: true };
}

function unpack(buf, outdir) {
  if (buf[0] !== 0xbe) throw new Error(`bad first byte 0x${buf[0].toString(16)}`);
  const bodyLen = buf.readUInt32BE(9);
  if (buf[13] !== 0xed) throw new Error(`bad tail byte 0x${buf[13].toString(16)}`);
  const count = buf.readUInt32BE(14);
  let p = 18;
  const files = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt32BE(p); p += 4;
    const name = buf.subarray(p, p + nameLen).toString('utf8'); p += nameLen;
    const off = buf.readUInt32BE(p); p += 4;
    const size = buf.readUInt32BE(p); p += 4;
    files.push({ name, off, size });
  }
  fs.mkdirSync(outdir, { recursive: true });
  let total = 0;
  for (const f of files) {
    const rel = f.name.replace(/^\//, '');
    const dest = path.join(outdir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf.subarray(f.off, f.off + f.size));
    total += f.size;
  }
  return { count, bodyLen, total };
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'decrypt') {
  const raw = fs.readFileSync(b);
  const { data, decrypted } = decrypt(a, raw);
  fs.mkdirSync(path.dirname(c), { recursive: true });
  fs.writeFileSync(c, data);
  console.log(`${decrypted ? 'decrypted' : 'plain'} ${raw.length} -> ${data.length} bytes, first=0x${data[0].toString(16)}`);
} else if (cmd === 'unpack') {
  const r = unpack(fs.readFileSync(a), b);
  console.log(`unpacked ${r.count} files, ${r.total} bytes -> ${b}`);
} else {
  console.error('usage: decrypt <appid> <in> <out> | unpack <in> <outdir>');
  process.exit(1);
}
