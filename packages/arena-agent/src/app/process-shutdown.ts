/** Shared graceful-shutdown bridge for OS signals and supervisor IPC. */

export interface ShutdownSignalSource {
  once(event: "SIGINT" | "SIGTERM", callback: () => void): unknown;
  on(event: "message", callback: (message: unknown) => void): unknown;
  off(event: "SIGINT" | "SIGTERM", callback: () => void): unknown;
  off(event: "message", callback: (message: unknown) => void): unknown;
}

export type ShutdownRequestDisposer = () => void;

/**
 * Register one idempotent shutdown request handler.
 *
 * The child owns graceful cleanup; the supervisor only sends `{type:"arena.shutdown"}`.
 * Returning a disposer prevents the IPC listener from keeping Node alive after cleanup.
 */
export function registerShutdownRequest(
  callback: () => void,
  source: ShutdownSignalSource = process,
): ShutdownRequestDisposer {
  let requested = false;
  const requestOnce = (): void => {
    if (requested) return;
    requested = true;
    callback();
  };
  const onMessage = (message: unknown): void => {
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "arena.shutdown"
    ) {
      requestOnce();
    }
  };

  source.once("SIGINT", requestOnce);
  source.once("SIGTERM", requestOnce);
  source.on("message", onMessage);

  return () => {
    source.off("SIGINT", requestOnce);
    source.off("SIGTERM", requestOnce);
    source.off("message", onMessage);
  };
}
