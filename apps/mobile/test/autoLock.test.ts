import assert from "node:assert/strict";
import { test } from "node:test";

import { armOnBackground, type AppStateLike } from "../src/autoLock.ts";

/** Stands in for React Native's AppState, which cannot be imported in a Node test. */
function fakeAppState() {
  let listener: ((state: string) => void) | null = null;
  let removed = false;
  const appState: AppStateLike = {
    addEventListener: (_type, next) => {
      listener = next;
      return {
        remove: () => {
          removed = true;
          listener = null;
        },
      };
    },
  };
  return {
    appState,
    emit: (state: string) => listener?.(state),
    isRemoved: () => removed,
  };
}

/** Lets the promise chain inside the listener settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("leaving the screen arms the lock", async () => {
  const fake = fakeAppState();
  let armed = 0;

  armOnBackground({
    appState: fake.appState,
    isLockEnabled: async () => true,
    onArm: () => {
      armed += 1;
    },
  });

  fake.emit("background");
  await settle();

  assert.equal(armed, 1);
});

test("staying in the foreground, or a dialog on top of the app, does not arm it", async () => {
  const fake = fakeAppState();
  let armed = 0;

  armOnBackground({
    appState: fake.appState,
    isLockEnabled: async () => true,
    onArm: () => {
      armed += 1;
    },
  });

  fake.emit("active");
  fake.emit("inactive");
  await settle();

  assert.equal(armed, 0);
});

test("the preference is read each time, so turning the lock on needs no restart", async () => {
  const fake = fakeAppState();
  let enabled = false;
  let armed = 0;

  armOnBackground({
    appState: fake.appState,
    isLockEnabled: async () => enabled,
    onArm: () => {
      armed += 1;
    },
  });

  fake.emit("background");
  await settle();
  assert.equal(armed, 0, "the lock is off, so there is nothing to arm");

  enabled = true;
  fake.emit("background");
  await settle();
  assert.equal(armed, 1);
});

test("an unavailable preference, or a removed listener, never arms the lock", async () => {
  const fake = fakeAppState();
  let armed = 0;

  const unsubscribe = armOnBackground({
    appState: fake.appState,
    isLockEnabled: async () => {
      throw new Error("device storage unavailable");
    },
    onArm: () => {
      armed += 1;
    },
  });

  fake.emit("background");
  await settle();
  assert.equal(armed, 0);

  unsubscribe();
  assert.equal(fake.isRemoved(), true);
});
