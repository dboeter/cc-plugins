// started: a session.start already logged in this process. Held by the host, so a hot reload of agent-log.tsx still reads it
export type Started = boolean // a contract must export a type, and `claude plugin validate` reads the key from the inline object below

declare module 'claude-code' {
  interface PluginState {
    'agent-log': { started: Started }
  }
}
