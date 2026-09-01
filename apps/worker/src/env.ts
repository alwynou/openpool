export interface Env {
  readonly APP_ENV: string;
  readonly APP_VERSION: string;
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly CREDENTIAL_MASTER_KEY?: string;
}

export interface Variables {
  readonly requestId: string;
}
