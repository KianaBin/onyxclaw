import assert from "node:assert/strict";
import test from "node:test";

import { resolveLandingView, resolveTabState } from "../public/ui-state.js";

test("a browser refresh always lands on lobster mode without resetting server progress", () => {
  assert.deepEqual(
    resolveLandingView({
      initialLanding: true,
      status: { mode: "connected", currentStep: "chat", soulConfirmed: true },
    }),
    { visibleStep: "mode" },
  );
});

test("after continuing, the UI follows the server-controlled serial step", () => {
  assert.deepEqual(
    resolveLandingView({
      initialLanding: false,
      status: { mode: "connected", currentStep: "soul", soulConfirmed: false },
    }),
    { visibleStep: "soul" },
  );
});

test("cloud allocation advances to personality", () => {
  assert.deepEqual(
    resolveLandingView({
      initialLanding: false,
      status: { mode: "allocated", currentStep: "soul", soulConfirmed: false },
    }),
    { visibleStep: "soul" },
  );
});

test("confirmed users can switch between lobster mode and chat after refresh", () => {
  assert.deepEqual(
    resolveTabState({ mode: "connected", currentStep: "chat", soulConfirmed: true }),
    {
      mode: { enabled: true, hidden: false },
      soul: { enabled: false, hidden: true },
      chat: { enabled: true, hidden: false },
    },
  );
});

test("paused cloud users keep chat context visible but cannot send until resumed", () => {
  const state = resolveTabState({
    mode: "paused",
    currentStep: "chat",
    soulConfirmed: true,
  });

  assert.equal(state.chat.hidden, false);
  assert.equal(state.chat.enabled, true);
  assert.equal(state.soul.hidden, true);
});

test("personality remains the only forward step before confirmation", () => {
  assert.deepEqual(
    resolveTabState({ mode: "allocated", currentStep: "soul", soulConfirmed: false }),
    {
      mode: { enabled: true, hidden: false },
      soul: { enabled: true, hidden: false },
      chat: { enabled: false, hidden: false },
    },
  );
});

test("resumed users must confirm the APP-held SOUL before chat", () => {
  assert.deepEqual(
    resolveTabState({
      mode: "resume-confirmation",
      currentStep: "soul",
      soulConfirmed: false,
    }),
    {
      mode: { enabled: true, hidden: false },
      soul: { enabled: true, hidden: false },
      chat: { enabled: false, hidden: false },
    },
  );
});

test("a running resume with delayed data session keeps the chat step available for retry", () => {
  const state = resolveTabState({
    mode: "resume-data-pending",
    currentStep: "chat",
    soulConfirmed: true,
  });

  assert.equal(state.chat.enabled, true);
  assert.equal(state.soul.hidden, true);
});
