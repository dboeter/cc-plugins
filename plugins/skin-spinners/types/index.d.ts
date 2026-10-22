// The mod's state contract. frame: its own 90 ms tick count, which moves only while it draws a spinner. startedAt: epoch ms when the
// latest main-loop turn began, counted from the prompt that started it where there was one; 0 before the first. outcomes: how each main-loop turn ended, for the footer's word, the newest 20.
// Keyed `d<durationMs>`, not by the bare number: a key that reads as an integer is kept in numeric order, so trimming to the
// newest 20 would drop the shortest turns, and an aborted turn is usually short.
declare module 'claude-code' {
  interface PluginState {
    'skin-spinners': {
      frame: number
      startedAt: number
      outcomes: Record<string, 'answer' | 'aborted' | 'refusal' | 'error'>
    }
  }
}
