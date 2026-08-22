export function resolveLandingView({ initialLanding, status }) {
  return {
    visibleStep: initialLanding ? "mode" : (status.currentStep ?? "mode"),
  };
}

export function resolveTabState(status) {
  const soulConfirmed = Boolean(status?.soulConfirmed);
  const connected = status?.mode === "connected";
  const paused = status?.mode === "paused";
  const personalityReady = status?.mode === "allocated" || connected || paused;
  return {
    mode: { enabled: true, hidden: false },
    soul: { enabled: personalityReady && !soulConfirmed, hidden: soulConfirmed },
    chat: { enabled: (connected || paused) && soulConfirmed, hidden: false },
  };
}
