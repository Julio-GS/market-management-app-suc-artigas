// ---------------------------------------------------------------------------
// Domain: Offline repository port
//
// Defines the contract that any Offline persistence implementation must fulfil.
// ---------------------------------------------------------------------------

import type {
  OfflineLoginIpcResult,
  OfflineLoginParams,
  OfflineSessionIpcResult,
  OfflineState,
} from "./offline";

export interface IOfflineRepository {
  getState(): OfflineState;
  getSession(): OfflineSessionIpcResult | null;
  login(params: OfflineLoginParams): Promise<OfflineLoginIpcResult>;
}
