// ---------------------------------------------------------------------------
// Application: Bootstrap use-case boundary
//
// Thin delegator. Depends only on the domain repository port. Contains no
// Electron, SQLite, fetch, validation, transformation, or error mapping.
// ---------------------------------------------------------------------------

import type { IBootstrapRepository } from "../../domain/bootstrap/bootstrap-repository";
import type { BootstrapResult } from "../../domain/bootstrap/bootstrap";

export class BootstrapService {
  constructor(private readonly bootstrapRepository: IBootstrapRepository) {}

  getStatus(): BootstrapResult {
    return this.bootstrapRepository.getStatus();
  }

  start(token: string, apiBaseUrl: string): Promise<BootstrapResult> {
    return this.bootstrapRepository.start(token, apiBaseUrl);
  }

  resume(token: string, apiBaseUrl: string): Promise<BootstrapResult> {
    return this.bootstrapRepository.resume(token, apiBaseUrl);
  }
}
