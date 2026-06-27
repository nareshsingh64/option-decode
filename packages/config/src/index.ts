import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(16),
  JWT_SECRET: z.string().min(16),
  DHAN_CLIENT_ID: z.string().min(1),
  DHAN_ACCESS_TOKEN: z.string().min(1),
  DHAN_API_BASE_URL: z.string().url().default("https://api.dhan.co"),
  MARKET_TIMEZONE: z.string().default("Asia/Kolkata"),
  FEED_UNDERLYINGS: z.string().default("NIFTY,BANKNIFTY"),
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  SNAPSHOT_CRON_PATTERN: z.string().trim().optional(),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SNAPSHOT_RETENTION_CRON_PATTERN: z.string().trim().default("0 30 1 * * *"),
  SNAPSHOT_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  VAPID_PUBLIC_KEY: z.string().trim().optional(),
  VAPID_PRIVATE_KEY: z.string().trim().optional(),
  VAPID_SUBJECT: z.string().trim().default("mailto:info@pytrade.co.in"),
  SMTP_HOST: z.string().trim().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase())),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().trim().default("Option Decode <no-reply@pytrade.co.in>"),
  MOCK_MARKET_FEED_ENABLED: z
    .string()
    .default("true")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase()))
});

export type AppConfig = z.infer<typeof envSchema> & {
  feedUnderlyings: string[];
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  return {
    ...parsed,
    feedUnderlyings: parsed.FEED_UNDERLYINGS.split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  };
}
