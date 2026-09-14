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
  | "error";

export interface ConnectionState {
  status: ConnectionStatus;
  error: string | null;
  setStatus: (status: ConnectionStatus) => void;
  setError: (error: string | null) => void;
}

export const connectionStore = createStore<ConnectionState>()((set) => ({
  status: "idle",
  error: null,
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
}));

export function useConnectionStore<T>(selector: (state: ConnectionState) => T): T {
  return useStore(connectionStore, selector);
}
