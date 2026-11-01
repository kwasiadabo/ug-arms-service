/**
 * S3-compatible object storage driver (SeaweedFS, Amazon S3 and similar services).
 *
 * The bucket is private: objects are only ever read by the API after an access check and streamed to the client.
 * The bucket is versioned and has S3 Object Lock enabled, so preservation files can be placed under governance
 * retention and legal hold (see services/objectLock.service.js).
 *
 * Two credentials are used. The application credential stores and reads files and sets or extends retention, but
 * the storage service refuses it any deletion of a version under retention. The disposal credential
 * (S3_DISPOSAL_ACCESS_KEY) is used only by `destroy`, for authorised disposal, and may bypass governance retention.
 * No credential can delete a version under legal hold.
 *
 * @author Kwasi Adabo Boakye
 */

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  CopyObjectCommand,
  ListObjectVersionsCommand,
  GetObjectLockConfigurationCommand,
  PutObjectRetentionCommand,
  PutObjectLegalHoldCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { env } from '../../config/env.js';

/**
 * Creates an S3 client for the configured storage service.
 *
 * @param {string} [accessKeyId] Access key; without one the SDK's default credential chain is used.
 * @param {string} [secretAccessKey] Matching secret.
 * @returns {S3Client}
 */
const s3Client = (accessKeyId, secretAccessKey) =>
  new S3Client({
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
  });

/**
 * Creates a storage driver for the configured S3 bucket.
 *
 * @returns {object} A driver with put, get, head, copy, remove, destroy, the Object Lock methods and healthCheck.
 */
export function createS3Driver() {
  const client = s3Client(env.S3_ACCESS_KEY, env.S3_SECRET_KEY);
  const disposalClient = env.S3_DISPOSAL_ACCESS_KEY
    ? s3Client(env.S3_DISPOSAL_ACCESS_KEY, env.S3_DISPOSAL_SECRET_KEY)
    : null;
  const Bucket = env.S3_BUCKET;
  let bucketReady = false;
  let lockEnabled;

  /**
   * Makes sure the bucket exists. Checked once per process.
   *
   * A missing bucket is created with Object Lock (which also enables versioning) where the credential allows it,
   * as on a cloud service. With SeaweedFS the bucket is prepared by infrastructure/seaweedfs/start.sh, because the
   * application credential may not create buckets.
   *
   * @returns {Promise<void>}
   * @throws {Error} When the bucket does not exist and cannot be created.
   */
  async function ensureBucket() {
    if (bucketReady) return;
    try {
      await client.send(new HeadBucketCommand({ Bucket }));
    } catch {
      try {
        await client.send(new CreateBucketCommand({ Bucket, ObjectLockEnabledForBucket: true }));
      } catch (err) {
        throw new Error(`Storage bucket "${Bucket}" does not exist and could not be created: ${err.message}`, {
          cause: err,
        });
      }
    }
    bucketReady = true;
  }

  /**
   * Lists every version and delete marker of exactly one key, following continuation markers.
   *
   * @param {string} key Storage key.
   * @returns {Promise<Array<{ VersionId: string }>>}
   */
  async function versionsOf(key) {
    const found = [];
    let KeyMarker;
    let VersionIdMarker;
    do {
      const page = await client.send(
        new ListObjectVersionsCommand({ Bucket, Prefix: key, KeyMarker, VersionIdMarker }),
      );
      for (const v of [...(page.Versions || []), ...(page.DeleteMarkers || [])]) if (v.Key === key) found.push(v);
      ({ NextKeyMarker: KeyMarker, NextVersionIdMarker: VersionIdMarker } = page.IsTruncated ? page : {});
    } while (KeyMarker);
    return found;
  }

  /**
   * Deletes every version and delete marker of a key with the given client, then confirms none is left.
   *
   * @param {S3Client} using Client to delete with.
   * @param {string} key Storage key.
   * @param {boolean} bypassGovernance Whether to send the governance-bypass header.
   * @returns {Promise<{ versions: number }>} How many versions and markers were deleted.
   * @throws {Error} When the storage service refuses a deletion or a version remains afterwards.
   */
  async function deleteAllVersions(using, key, bypassGovernance) {
    const versions = await versionsOf(key);
    for (const v of versions)
      await using.send(
        new DeleteObjectCommand({
          Bucket,
          Key: key,
          VersionId: v.VersionId,
          BypassGovernanceRetention: bypassGovernance || undefined,
        }),
      );
    if ((await versionsOf(key)).length) throw new Error(`Versions of ${key} remain after deletion`);
    return { versions: versions.length };
  }

  return {
    name: 's3',

    /**
     * Stores a new object under the given key using a multipart upload (16 MB parts, four in parallel), which the
     * SDK retries part by part.
     *
     * The bucket is created on first use if necessary.
     *
     * @param {string} key Storage key built with `buildKey`.
     * @param {import('node:stream').Readable|Buffer|string} body Content to store.
     * @param {{ contentType?: string, metadata?: Record<string, string> }} [options] Content type and user
     *   metadata, such as the SHA-256 recorded at ingest.
     * @returns {Promise<{ key: string }>}
     */
    async put(key, body, { contentType, metadata } = {}) {
      await ensureBucket();
      // Multipart upload for large objects; parts are retried by the SDK.
      const upload = new Upload({
        client,
        params: { Bucket, Key: key, Body: body, ContentType: contentType, Metadata: metadata },
        queueSize: 4,
        partSize: 16 * 1024 * 1024,
      });
      await upload.done();
      return { key };
    },

    /**
     * Opens an object for reading, optionally for a byte range so that audio, video and large PDFs can be streamed.
     *
     * @param {string} key Storage key.
     * @param {{ range?: string }} [options] HTTP Range header value, for example "bytes=0-1023".
     * @returns {Promise<{ body: import('node:stream').Readable, contentLength: number, contentRange?: string,
     *   contentType?: string }>}
     */
    async get(key, { range } = {}) {
      const out = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
      return {
        body: out.Body,
        contentLength: out.ContentLength,
        contentType: out.ContentType,
        contentRange: out.ContentRange,
      };
    },

    /**
     * Checks whether an object exists and returns its size, without reading its content.
     *
     * @param {string} key Storage key.
     * @returns {Promise<{ exists: boolean, size?: number, contentType?: string }>}
     */
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { exists: true, size: out.ContentLength, contentType: out.ContentType };
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return { exists: false };
        throw err;
      }
    },

    /**
     * Copies an object to a new key. Used for replication and for restoring an asset from a verified copy.
     *
     * @param {string} fromKey Key of the source object.
     * @param {string} toKey Key of the new copy.
     * @returns {Promise<void>}
     */
    async copy(fromKey, toKey) {
      await ensureBucket();
      await client.send(
        new CopyObjectCommand({ Bucket, Key: toKey, CopySource: `${Bucket}/${encodeURIComponent(fromKey)}` }),
      );
    },

    /**
     * Deletes an object completely, including every earlier version, so no copy of the content is left behind.
     * Removing a key that does not exist is not an error.
     *
     * Used for files that were never placed under retention, such as rejected duplicates and temporary uploads.
     * The storage service refuses the deletion of a version under retention or legal hold.
     *
     * @param {string} key Storage key.
     * @returns {Promise<void>}
     */
    async remove(key) {
      await deleteAllVersions(client, key, false);
    },

    /**
     * Destroys an object under authorised disposal: every version is deleted with the disposal credential, which
     * may bypass governance retention, and the deletion is then confirmed.
     *
     * @param {string} key Storage key.
     * @returns {Promise<{ versions: number }>} How many versions and markers were deleted.
     * @throws {Error} When no disposal credential is configured and the object is under retention, when the object
     *   is under legal hold, or when any version remains.
     */
    async destroy(key) {
      return deleteAllVersions(disposalClient || client, key, Boolean(disposalClient));
    },

    /**
     * Tells whether the bucket has S3 Object Lock enabled. Checked once per process.
     *
     * @returns {Promise<boolean>}
     */
    async objectLockEnabled() {
      if (lockEnabled === undefined) {
        await ensureBucket();
        try {
          const out = await client.send(new GetObjectLockConfigurationCommand({ Bucket }));
          lockEnabled = out.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
        } catch (err) {
          if (err.name !== 'ObjectLockConfigurationNotFoundError') throw err;
          lockEnabled = false;
        }
      }
      return lockEnabled;
    },

    /**
     * Reads the retention and legal hold of the current version of an object.
     *
     * @param {string} key Storage key.
     * @returns {Promise<{ exists: boolean, mode?: string, retainUntil?: Date, legalHold?: boolean }>}
     */
    async lockStatus(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          exists: true,
          mode: out.ObjectLockMode,
          retainUntil: out.ObjectLockRetainUntilDate,
          legalHold: out.ObjectLockLegalHoldStatus === 'ON',
        };
      } catch (err) {
        if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') return { exists: false };
        throw err;
      }
    },

    /**
     * Places the current version of an object under governance retention until the given date. The storage
     * service refuses to shorten an existing retention period.
     *
     * @param {string} key Storage key.
     * @param {Date} retainUntil End of the retention period.
     * @returns {Promise<void>}
     */
    async retain(key, retainUntil) {
      await client.send(
        new PutObjectRetentionCommand({
          Bucket,
          Key: key,
          Retention: { Mode: 'GOVERNANCE', RetainUntilDate: retainUntil },
        }),
      );
    },

    /**
     * Places or removes a legal hold on the current version of an object. While the hold is on, no credential can
     * delete that version.
     *
     * @param {string} key Storage key.
     * @param {boolean} on Whether the hold should be on.
     * @returns {Promise<void>}
     */
    async setLegalHold(key, on) {
      await client.send(new PutObjectLegalHoldCommand({ Bucket, Key: key, LegalHold: { Status: on ? 'ON' : 'OFF' } }));
    },

    /**
     * Confirms that the storage backend is reachable and usable; shown on the System health page.
     *
     * @returns {Promise<{ driver: string, bucket: string, objectLock: boolean, disposalCredential: boolean }>}
     */
    async healthCheck() {
      await ensureBucket();
      return {
        driver: 's3',
        bucket: Bucket,
        objectLock: await this.objectLockEnabled(),
        disposalCredential: Boolean(disposalClient),
      };
    },
  };
}
