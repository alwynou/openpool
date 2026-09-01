export interface Env {
  readonly APP_ENV: string;
  readonly APP_VERSION: string;
  readonly ASSETS: Fetcher;
  readonly DB: D1Database;
  readonly ADMIN_BOOTSTRAP_TOKEN?: string;
  readonly CREDENTIAL_MASTER_KEY?: string;
  readonly CREDENTIAL_MASTER_KEY_ID?: string;
  readonly API_KEY_PEPPER?: string;
}

export interface Variables {
  readonly requestId: string;
}
