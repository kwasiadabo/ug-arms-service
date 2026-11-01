/**
 * Disk space monitoring for the upload staging area and, when the local storage driver is used, the local object
 * store. Running out of space during an upload or ingest would cause failures that are hard to diagnose, so
 * administrators are warned in advance.
 *
 * @author Kwasi Adabo Boakye
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { notifyPermissionHolders } from './notification.service.js';

/**
 * Measures the total and free space of each monitored folder.
 *
 * @returns {Promise<Array<{ path: string, totalBytes?: number, freeBytes?: number, freePercent?: number, error?:
 *   string }>>} One entry per folder; an `error` is reported instead of the figures when a folder cannot be measured.
 */
export async function diskUsage() {
  const targets = [path.resolve('uploads/tmp')];
  if (env.STORAGE_DRIVER === 'local') targets.push(path.resolve(env.STORAGE_LOCAL_ROOT));
  const out = [];
  for (const t of targets) {
    try {
      await fs.mkdir(t, { recursive: true });
      const s = await fs.statfs(t);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      out.push({ path: t, totalBytes: total, freeBytes: free, freePercent: Math.round((free / total) * 1000) / 10 });
    } catch (err) {
      out.push({ path: t, error: err.message });
    }
  }
  return out;
}

/**
 * Scheduled check: notifies everyone with the "system.health" permission when free space on a monitored folder
 * falls below DISK_FREE_ALERT_PERCENT.
 *
 * @returns {Promise<{ usage: object[], alerted: number }>} The measurements and the number of folders below the
 *   threshold.
 */
export async function checkDiskCapacity() {
  const usage = await diskUsage();
  const low = usage.filter((u) => u.freePercent !== undefined && u.freePercent < env.DISK_FREE_ALERT_PERCENT);
  if (low.length) {
    await notifyPermissionHolders(['system.health'], {
      eventType: 'system.error',
      title: 'Low disk space',
      body: low.map((u) => `${u.path}: ${u.freePercent}% free`).join('\n'),
      link: '/admin/system',
    });
  }
  return { usage, alerted: low.length };
}
