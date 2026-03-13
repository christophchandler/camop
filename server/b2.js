const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let s3Client = null;

function getClient() {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: process.env.B2_BUCKET_ENDPOINT,
      region: 'us-west-002',
      credentials: {
        accessKeyId: process.env.B2_ACCOUNT_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY
      },
      forcePathStyle: true
    });
  }
  return s3Client;
}

async function generatePresignedPutUrl(fileName, contentType) {
  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: fileName,
    ContentType: contentType
  });

  // URL valid for 1 hour
  const url = await getSignedUrl(client, command, { expiresIn: 3600 });
  return url;
}

async function generatePresignedGetUrl(fileName) {
  const client = getClient();
  const command = new GetObjectCommand({
    Bucket: process.env.B2_BUCKET_NAME,
    Key: fileName
  });
  const url = await getSignedUrl(client, command, { expiresIn: 3600 });
  return url;
}

module.exports = { generatePresignedPutUrl, generatePresignedGetUrl };
