import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnv } from "../../config/index.js";

let client: S3Client | undefined;

export function getS3Client(): S3Client {
  if (!client) {
    const env = getEnv();
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
      forcePathStyle: env.S3_FORCE_PATH_STYLE
    });
  }
  return client;
}

export async function presignPut(key: string, contentType: string, bucket?: string): Promise<string> {
  const env = getEnv();
  const cmd = new PutObjectCommand({
    Bucket: bucket ?? env.S3_BUCKET_IMAGES,
    Key: key,
    ContentType: contentType
  });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: env.S3_PRESIGN_TTL_SECONDS });
}

export async function presignGet(key: string, bucket?: string): Promise<string> {
  const env = getEnv();
  const cmd = new GetObjectCommand({
    Bucket: bucket ?? env.S3_BUCKET_IMAGES,
    Key: key
  });
  return getSignedUrl(getS3Client(), cmd, { expiresIn: env.S3_PRESIGN_TTL_SECONDS });
}

export async function closeS3(): Promise<void> {
  if (client) {
    client.destroy();
    client = undefined;
  }
}
