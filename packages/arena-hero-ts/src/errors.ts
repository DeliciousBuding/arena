/** Exceptions raised by the Arena Hero SDK. */

/** Base class for all SDK errors. */
export class ArenaHeroError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The client was initialized with an invalid option. */
export class ConfigurationError extends ArenaHeroError {}

/** The server sent a message that violates the public protocol. */
export class ProtocolError extends ArenaHeroError {}

/** A network operation failed after safe retries were exhausted. */
export class TransportError extends ArenaHeroError {}

/** The server rejected the API key. */
export class AuthenticationError extends ArenaHeroError {}

/** The WebSocket connection closed with policy-violation code 1008. */
export class PolicyViolationError extends ArenaHeroError {}

/** An action was added to a Turn that is no longer current. */
export class TurnClosedError extends ArenaHeroError {}

/** An action cannot be represented by the Arena Hero command protocol. */
export class InvalidActionError extends ArenaHeroError {}

/** The command API rejected a request. */
export class APIError extends ArenaHeroError {
  readonly statusCode: number;
  readonly error: string;
  /** 服务端 message（可能为 null）——命名避开 Error.message。 */
  readonly apiMessage: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    error: string,
    apiMessage: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    const description = apiMessage
      ? `${statusCode} ${error}: ${apiMessage}`
      : `${statusCode} ${error}`;
    super(description);
    this.statusCode = statusCode;
    this.error = error;
    this.apiMessage = apiMessage;
    this.details = details ?? {};
  }
}
