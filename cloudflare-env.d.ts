declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    CUSTOMER_HTTP_GPU?: Fetcher;
  }
}
