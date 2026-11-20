/**
 * Locking the app again once it leaves the screen.
 *
 * A cold start was the only case covered, but the phone that matters is the one left open on a
 * branch desk while everyone walks to the counter. React Native reports the app moving to the
 * background, so that is the moment to arm the lock: by the time the phone is picked up again the
 * unlock screen is already what is showing.
 *
 * The preference is read on every transition rather than captured once, because the lock can be
 * turned on in More without the app being restarted. The wiring lives here, apart from the screen,
 * so it can be tested without React Native.
 */

export interface AppStateLike {
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

export interface AutoLockOptions {
  appState: AppStateLike;
  isLockEnabled: () => Promise<boolean>;
  onArm: () => void;
}

/** Arms the lock whenever the app goes to the background. Returns the unsubscribe function. */
export function armOnBackground(options: AutoLockOptions): () => void {
  const subscription = options.appState.addEventListener("change", (next) => {
    // "inactive" is a swipe or a system dialog on top of the app, not someone walking away.
    if (next !== "background") return;
    void options
      .isLockEnabled()
      .then((enabled) => {
        if (enabled) options.onArm();
      })
      .catch(() => undefined);
  });

  return () => subscription.remove();
}
