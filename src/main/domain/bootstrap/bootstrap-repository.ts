// ---------------------------------------------------------------------------
// Domain: Bootstrap repository port
//
// Exposes only the three existing public operations. Snapshot ingestion
// remains a private infrastructure concern.
// ---------------------------------------------------------------------------

import type { BootstrapResult } from "./bootstrap";

export interface IBootstrapRepository {
  getStatus(): BootstrapResult;
  start(token: string, apiBaseUrl: string): Promise<BootstrapResult>;
  resume(token: string, apiBaseUrl: string): Promise<BootstrapResult>;
}
