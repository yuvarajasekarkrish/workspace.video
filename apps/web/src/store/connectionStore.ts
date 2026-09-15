import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Connection/session status — low-frequency (changes on connect/disconnect/
 * error, not on movement), so this is the one store React components may
 * subscribe to directly via the `useConnectionStore` hook below.
 */
export type ConnectionStatus =
  | "idle"
  | "resolving-endpoint"
  | "connecting"
  | "joining"
  | "connected"
  | "reconnecting"
  | "workspace_full"
  | "error";

/** Set only when status is "workspace_full" — the numbers the join was
 *  rejected with, straight from the join_room ack (see RealtimeClient). */
export interface CapacityInfo {
  active: number;
  limit: number;
}

export interface ConnectionState {
  status: ConnectionStatus;
  error: string | null;
  capacity: CapacityInfo | null;
  setStatus: (status: ConnectionStatus) => void;
  setError: (error: string | null) => void;
  setCapacity: (capacity: CapacityInfo | null) => void;
}

export const connectionStore = createStore<ConnectionState>()((set) => ({
  status: "idle",
  error: null,
  capacity: null,
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setCapacity: (capacity) => set({ capacity }),
}));

export function useConnectionStore<T>(selector: (state: ConnectionState) => T): T {
  return useStore(connectionStore, selector);
}
