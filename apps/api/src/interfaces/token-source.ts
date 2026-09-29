/** Where a request's code-host credential comes from: a local CLI login or a signed-in session. */
export interface Session {
  token: string;
  login: string;
  avatarUrl: string;
  expiresAt: number;
}

export interface SessionStore {
  create(session: Omit<Session, "expiresAt">): string;
  get(id: string): Session | null;
  delete(id: string): void;
}

export interface CliTokenSource {
  /** Resolves the local login, throwing a readable error when there is none. */
  session(): Promise<Session>;
}
