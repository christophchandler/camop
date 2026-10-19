const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let s3Client = null;

// B2 endpoints look like https://s3.us-west-004.backblazeb2.com; the region is the
// middle part. Anything else (a local S3 used for tests) falls back to us-east-1.
function regionFromEndpoint(endpoint) {
  const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint || '');
  return m ? m[1] : (process.env.S3_REGION || 'us-east-1');
}

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.B2_BUCKET_ENDPOINT,
      region: regionFromEndpoint(process.env.B2_BUCKET_ENDPOINT),
      credentials: {
        accessKeyId: process.env.B2_ACCOUNT_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY
      },
      forcePathStyle: true,
      // Newer AWS SDKs add checksum trailers by default that S3-compatible
      // stores like B2 can reject; only send them when an operation requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
  }
  return s3Client;
}

const BUCKET = () => process.env.B2_BUCKET_NAME;

async function generatePresignedPutUrl(key, contentType) {
  const command = new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType });
  return getSignedUrl(getClient(), command, { expiresIn: 3600 });
}

async function generatePresignedGetUrl(key) {
  const command = new GetObjectCommand({ Bucket: BUCKET(), Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: 3600 });
}

async function createMultipart(key, contentType) {
  const res = await getClient().send(new CreateMultipartUploadCommand({
    Bucket: BUCKET(), Key: key, ContentType: contentType
  }));
  return res.UploadId;
}

// Guests upload parts to CamOp's own address and the server streams them on,
// so no bucket CORS rule is needed and corporate firewalls see one hostname.
async function uploadPart(key, uploadId, partNumber, body, contentLength) {
  const res = await getClient().send(new UploadPartCommand({
    Bucket: BUCKET(), Key: key, UploadId: uploadId, PartNumber: partNumber,
    Body: body, ContentLength: contentLength
  }));
  return res.ETag;
}

// The server asks storage for the part list instead of trusting ETags from the
// browser, so a bucket CORS rule that hides the ETag header can't break completion.
async function listAllParts(key, uploadId) {
  const parts = [];
  let marker;
  for (;;) {
    const res = await getClient().send(new ListPartsCommand({
      Bucket: BUCKET(), Key: key, UploadId: uploadId, PartNumberMarker: marker
    }));
    for (const p of res.Parts || []) parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
    if (!res.IsTruncated) break;
    marker = res.NextPartNumberMarker;
  }
  parts.sort((a, b) => a.PartNumber - b.PartNumber);
  return parts;
}

async function completeMultipart(key, uploadId, parts) {
  await getClient().send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET(), Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map(p => ({ PartNumber: p.PartNumber, ETag: p.ETag })) }
  }));
}

async function abortMultipart(key, uploadId) {
  await getClient().send(new AbortMultipartUploadCommand({ Bucket: BUCKET(), Key: key, UploadId: uploadId }));
}

async function headObject(key) {
  const res = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }));
  return { size: res.ContentLength };
}

// Small JSON documents (the session manifest) are written whole.
async function putText(key, text, contentType = 'application/json') {
  await getClient().send(new PutObjectCommand({
    Bucket: BUCKET(), Key: key, Body: text, ContentType: contentType, ContentLength: Buffer.byteLength(text)
  }));
}

async function getText(key) {
  const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  return res.Body.transformToString();
}

// Every key in the bucket (with its last-modified time), a page of 1000 at a time.
async function listKeys(maxPages = 100) {
  const out = [];
  let token;
  for (let page = 0; page < maxPages; page++) {
    const res = await getClient().send(new ListObjectsV2Command({ Bucket: BUCKET(), ContinuationToken: token }));
    for (const o of res.Contents || []) out.push({ key: o.Key, modified: o.LastModified, size: o.Size });
    if (!res.IsTruncated) break;
    token = res.NextContinuationToken;
  }
  return out;
}

module.exports = {
  putText,
  getText,
  listKeys,
  generatePresignedPutUrl,
  generatePresignedGetUrl,
  createMultipart,
  uploadPart,
  listAllParts,
  completeMultipart,
  abortMultipart,
  headObject,
  regionFromEndpoint
};
