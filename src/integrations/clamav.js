/**
 * Malware scanning through a ClamAV daemon (clamd).
 *
 * Every uploaded file is untrusted and is scanned before it can be processed further or published. When ClamAV is
 * disabled the scan result is "skipped", and callers must treat the file as not yet scanned rather than as clean.
 *
 * @author Kwasi Adabo Boakye
 */

import net from 'node:net';
import fs from 'node:fs';
import { env } from '../config/env.js';

/**
 * Scans a file with clamd using the INSTREAM protocol.
 *
 * The file is streamed to the daemon in 64 KB chunks, each prefixed with its length, and terminated with a
 * zero-length chunk. The scan is abandoned after two minutes. Connection errors and unexpected replies are reported
 * as "error" so the file is held for a re-scan instead of being treated as clean.
 *
 * @param {string} filePath Path of the file to scan.
 * @returns {Promise<{ status: 'clean'|'infected'|'skipped'|'error', signature?: string, error?: string }>} The scan
 *   result; `signature` names the detected malware when the file is infected.
 */
export async function scanFile(filePath) {
  if (!env.CLAMAV_ENABLED) return { status: 'skipped' };
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT });
    let response = '';

    /**
     * Closes the connection to clamd and settles the scan with the given result. Only the first call has an effect.
     *
     * @param {{ status: string, signature?: string, error?: string }} result The scan result.
     */
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(120_000, () => done({ status: 'error', error: 'ClamAV timeout' }));
    socket.on('error', (err) => done({ status: 'error', error: err.message }));
    socket.on('data', (d) => {
      response += d.toString();
    });
    socket.on('end', () => {
      if (/OK\s*$/.test(response.replace(/\0/g, ''))) return done({ status: 'clean' });
      const m = /stream: (.+) FOUND/.exec(response);
      if (m) return done({ status: 'infected', signature: m[1] });
      return done({ status: 'error', error: response.trim() || 'Unknown ClamAV response' });
    });
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
      stream.on('data', (chunk) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length);
        socket.write(size);
        socket.write(chunk);
      });
      stream.on('end', () => socket.write(Buffer.alloc(4)));
      stream.on('error', (err) => done({ status: 'error', error: err.message }));
    });
  });
}
