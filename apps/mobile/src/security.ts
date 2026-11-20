/**
 * A shared branch phone should not open straight onto the board.
 *
 * The lock is a device preference, not a server permission: it protects the phone in a drawer, and
 * it must never be the only thing standing between a person and the audit trail. Device biometrics
 * are asked for; the PIN fallback is the device's own, so this app never stores a second secret.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";

const STORAGE_KEY = "bankbuddy.app-lock.v1";

export async function isAppLockEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) === "on";
  } catch {
    return false;
  }
}

/** Enabling needs hardware and an enrolled finger/face, otherwise it would lock the app for good. */
export async function enableAppLock(): Promise<{ ok: boolean; message?: string }> {
  try {
    const capable = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!capable || !enrolled) {
      return { ok: false, message: "Set up a fingerprint or face unlock on this phone first." };
    }
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Confirm it is you",
      cancelLabel: "Cancel",
    });
    if (!result.success) return { ok: false, message: "Not unlocked, so the lock stays off." };
    await AsyncStorage.setItem(STORAGE_KEY, "on");
    return { ok: true };
  } catch {
    return { ok: false, message: "This phone cannot use biometrics." };
  }
}

export async function disableAppLock(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function unlockApp(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock BankBuddy",
      cancelLabel: "Cancel",
    });
    return result.success;
  } catch {
    return false;
  }
}
