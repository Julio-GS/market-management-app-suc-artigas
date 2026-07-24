// ---------------------------------------------------------------------------
// Application: Offline use-case boundary
//
// Delegates to IOfflineRepository. Contains no Electron, SQLite, fetch, or
// validation logic. Exists to preserve the established hexagonal shape and
// isolate adapters from infrastructure.
// ---------------------------------------------------------------------------

import type { IOfflineRepository } from "../../domain/offline/offline-repository";
import type {
  OfflineLoginIpcResult,
  OfflineLoginParams,
  OfflineSessionIpcResult,
  OfflineState,
} from "../../domain/offline/offline";

export class OfflineService {
  constructor(private readonly offlineRepository: IOfflineRepository) {}

  getState(): OfflineState {
    return this.offlineRepository.getState();
  }

  getSession(): OfflineSessionIpcResult | null {
    return this.offlineRepository.getSession();
  }

  login(params: OfflineLoginParams): Promise<OfflineLoginIpcResult> {
    return this.offlineRepository.login(params);
  }
}
