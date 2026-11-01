/**
 * Technical metadata extraction for audio and video files using ffprobe (part of FFmpeg).
 *
 * @author Kwasi Adabo Boakye
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.js';

const run = promisify(execFile);

/**
 * Reads the duration, container format, bit rate and the main video and audio stream properties of a media file.
 *
 * ffprobe is run as a separate process with a timeout and an output size limit; the file is only read, never
 * executed. If ffprobe is not installed or the file cannot be read, an object describing the error is returned
 * instead of throwing, so ingest can continue without audiovisual metadata.
 *
 * @param {string} filePath Path of the audio or video file.
 * @returns {Promise<object>} The technical metadata, or `{ error }` when it could not be extracted.
 */
export async function probe(filePath) {
  try {
    const { stdout } = await run(
      env.FFPROBE_PATH,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout);
    const video = data.streams?.find((s) => s.codec_type === 'video');
    const audio = data.streams?.find((s) => s.codec_type === 'audio');
    return {
      durationSeconds: data.format?.duration ? Number(data.format.duration) : null,
      formatName: data.format?.format_long_name,
      bitRate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
      video: video
        ? { codec: video.codec_name, width: video.width, height: video.height, frameRate: video.r_frame_rate }
        : null,
      audio: audio
        ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels }
        : null,
      tool: 'ffprobe',
    };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'ffprobe not installed' : err.message };
  }
}
