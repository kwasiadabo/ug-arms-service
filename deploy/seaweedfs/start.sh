#!/bin/sh
# Starts SeaweedFS as the S3-compatible object store for UG-ARMS (master, volume server, filer and S3 gateway in one
# process) and prepares the application bucket with S3 Object Lock.
#
# Credentials are taken from the environment at start-up and written to a private temporary file, so no secret is
# stored in the repository or the image. There is deliberately no anonymous identity and no S3 administrator: every
# request must be signed, and each identity may act only on buckets whose names start with S3_BUCKET.
#
#   S3_ACCESS_KEY / S3_SECRET_KEY                    application (API and worker). May store files, read them, and
#                                                    set or extend retention and legal holds. Cannot shorten
#                                                    retention or delete a version that is under retention.
#   S3_DISPOSAL_ACCESS_KEY / S3_DISPOSAL_SECRET_KEY  authorised disposal only (API). May delete a version under
#                                                    governance retention when it sends the bypass header. Optional:
#                                                    without it, locked files cannot be destroyed at all. No identity
#                                                    can delete a version under legal hold.
#
# The bucket is created with Object Lock, or Object Lock is switched on if the bucket already exists (this cannot be
# undone). Both steps go through `weed shell`, which talks to the master and filer directly and so needs no S3
# administrator credentials.
set -eu

BUCKET="${S3_BUCKET:-ug-arms-objects}"
: "${S3_ACCESS_KEY:?set S3_ACCESS_KEY}"
: "${S3_SECRET_KEY:?set S3_SECRET_KEY}"
DISPOSAL_KEY="${S3_DISPOSAL_ACCESS_KEY:-}"
DISPOSAL_SECRET="${S3_DISPOSAL_SECRET_KEY:-}"
case "$S3_ACCESS_KEY$S3_SECRET_KEY$DISPOSAL_KEY$DISPOSAL_SECRET" in
  *'"'* | *'\'*) echo "S3 keys and secrets must not contain quotes or backslashes" >&2; exit 1 ;;
esac
if ! echo "$BUCKET" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'; then
  echo "S3_BUCKET is not a valid bucket name: $BUCKET" >&2
  exit 1
fi

# Prints a JSON array of actions, each limited to the application's buckets.
actions() {
  out=''
  for a in "$@"; do out="$out${out:+, }\"$a:$BUCKET*\""; done
  echo "[$out]"
}

rm -f /tmp/bucket-ready
umask 077
CONFIG=/tmp/s3.json
{
  echo '{ "identities": ['
  echo "  { \"name\": \"ug-arms\","
  echo "    \"credentials\": [{ \"accessKey\": \"$S3_ACCESS_KEY\", \"secretKey\": \"$S3_SECRET_KEY\" }],"
  echo "    \"actions\": $(actions Read List Tagging Write GetObjectRetention PutObjectRetention GetObjectLegalHold \
    PutObjectLegalHold GetBucketObjectLockConfiguration) }"
  if [ -n "$DISPOSAL_KEY" ]; then
    echo "  , { \"name\": \"ug-arms-disposal\","
    echo "    \"credentials\": [{ \"accessKey\": \"$DISPOSAL_KEY\", \"secretKey\": \"$DISPOSAL_SECRET\" }],"
    echo "    \"actions\": $(actions Read List Write GetObjectRetention GetObjectLegalHold BypassGovernanceRetention) }"
  fi
  echo '] }'
} > "$CONFIG"

# -dir must be the mounted volume: the default (/tmp) would lose every file when the container is recreated.
# Volumes of 1 GB (instead of 30 GB) suit a single server; -volume.max=0 sizes the count from free disk space.
weed server \
  -dir=/data \
  -ip="${SEAWEEDFS_IP:-seaweedfs}" \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB="${SEAWEEDFS_VOLUME_SIZE_MB:-1024}" \
  -volume.max=0 \
  -s3 \
  -s3.port=8333 \
  -s3.config="$CONFIG" &
PID=$!
trap 'kill -TERM "$PID" 2>/dev/null' TERM INT

# Creates the bucket with Object Lock, or switches Object Lock on for an existing bucket. Safe to repeat.
prepare_bucket() {
  status=$(echo "s3.bucket.lock -name $BUCKET" | weed shell -master=127.0.0.1:9333 2>&1) || true
  case "$status" in
    *'Object Lock: Enabled'*) return 0 ;;
    *'Object Lock: Disabled'*) echo "s3.bucket.lock -name $BUCKET -enable" | weed shell -master=127.0.0.1:9333 ;;
    *'no entry is found'*) echo "s3.bucket.create -name $BUCKET -withLock" | weed shell -master=127.0.0.1:9333 ;;
    *) return 1 ;;
  esac
  echo "s3.bucket.lock -name $BUCKET" | weed shell -master=127.0.0.1:9333 2>&1 | grep -q 'Object Lock: Enabled'
}

tries=0
until prepare_bucket; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "Could not prepare bucket $BUCKET with Object Lock" >&2
    kill -TERM "$PID" 2>/dev/null || true
    exit 1
  fi
  sleep 2
done
echo "Bucket $BUCKET is ready with Object Lock enabled"
touch /tmp/bucket-ready
wait "$PID"
